import { and, desc, eq, gte, lt } from 'drizzle-orm'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { cameras, streamEvents } from '../db/schema'
import { listTimespans, MediaMtxError } from '../mediamtx/client'
import { requireSession, type SessionEnv } from '../middleware/session'
import {
  coverage,
  gaps,
  inferCause,
  merge,
  TOLERANCE_MS,
  type GapCause,
  type Span,
  type StreamEvent,
} from '../timeline/coverage'

// The epoch-ms -> RFC3339 boundary for the response, and the only one in this
// file. Everything above it is epoch milliseconds UTC
// (docs/ARCHITECTURE.md#timeline-gaps-and-coverage); camera-local formatting
// happens in the browser, which is the render boundary. SPEC 4.4 shows the
// window with a +07:00 offset, but emitting a camera-local offset here would
// put the conversion in the wrong layer, so every timestamp goes out as Z.
const iso = (ms: number) => new Date(ms).toISOString()

// Whole seconds, matching SPEC 4.4's integers. Deliberately lossy against
// `coverage`, which stays exact: never re-derive coverage on the client by
// summing durationSec.
const durationSec = (s: Span) => Math.round((s.end - s.start) / 1000)

export type TimelineBody = {
  window: { from: string; to: string }
  spans: { start: string; end: string; durationSec: number }[]
  gaps: { start: string; end: string; durationSec: number; cause: GapCause }[]
  coverage: number
  clamped?: { spanCount: number; excessSec: number }
}

// Same shape as live.ts's, redefined rather than imported: that module holds a
// live WHEP session Map, and one regex is not worth reaching into it for.
const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9_-]{1,64}$/) })

// A week, which is recordDeleteAfter (168h). Mirrors the bound clip puts on
// `duration` (docs/ARCHITECTURE.md#the-trust-boundary): an endpoint that takes
// a window should not accept an unbounded one.
const MAX_WINDOW_MS = 7 * 24 * 3_600_000

// refine AFTER transform, deliberately. `to > from` on the raw strings would be
// a lexicographic comparison, and "2026-08-25T00:00:00+07:00" sorts after
// "2026-08-24T20:00:00Z" while naming an earlier instant.
//
// The comparison is also the NaN guard: Date.parse of anything z.iso.datetime
// accepts is finite today, but Number.isFinite says so on purpose rather than
// by luck, exactly as mediamtx/client.ts does at the other end of the boundary.
const timelineQuery = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .transform(({ from, to }) => ({ from: Date.parse(from), to: Date.parse(to) }))
  .refine((w) => Number.isFinite(w.from) && Number.isFinite(w.to), 'unparsable RFC3339 timestamp')
  // coverage() divides by the window's length and returns NaN for a
  // zero-length one. It leaves that unguarded on purpose so the route can
  // answer a bad request honestly instead of serving NaN, which JSON turns
  // into null while the response type still claims number.
  .refine((w) => w.to > w.from, 'to must be after from')
  .refine((w) => w.to - w.from <= MAX_WINDOW_MS, 'window may not exceed 7 days')

async function findCamera(slug: string) {
  const [camera] = await db
    .select({ slug: cameras.slug, enabled: cameras.enabled })
    .from(cameras)
    .where(eq(cameras.slug, slug))
    .limit(1)

  return camera?.enabled ? camera : null
}

// The poller writes TRANSITIONS only (docs/ARCHITECTURE.md#data), so the events
// inside a window are not the whole story: a camera that went down at 22:00
// yesterday and is still down leaves today's window with no event in it at all,
// and inferCause - which only matches an event inside the gap - would call the
// resulting all-day outage `unknown`. The one gap most worth labelling would be
// the one guaranteed to be mislabelled.
//
// So the state at the window's start is carried forward from the last
// transition before it. That is reading a known fact forward, not inventing a
// cause: if the last thing the poller saw was `down`, the camera was down when
// the window opened.
async function loadEvents(slug: string, from: number, to: number): Promise<StreamEvent[]> {
  const rows = await db
    .select({ kind: streamEvents.kind, at: streamEvents.at })
    .from(streamEvents)
    .where(
      and(
        eq(streamEvents.cameraSlug, slug),
        gte(streamEvents.at, new Date(from)),
        lt(streamEvents.at, new Date(to)),
      ),
    )
    .orderBy(streamEvents.at)

  const [previous] = await db
    .select({ kind: streamEvents.kind })
    .from(streamEvents)
    .where(and(eq(streamEvents.cameraSlug, slug), lt(streamEvents.at, new Date(from))))
    .orderBy(desc(streamEvents.at))
    .limit(1)

  // row.at.getTime() is the Date -> epoch-ms conversion, and it happens exactly
  // here. A Date must never reach timeline/. The `new Date(from)` above is the
  // mirror image and never leaves this function.
  const inWindow: StreamEvent[] = rows.map((row) => ({ kind: row.kind, at: row.at.getTime() }))

  return previous?.kind === 'down' ? [{ kind: 'down', at: from }, ...inWindow] : inWindow
}

// Pure: timespans, events and a clock in, response body out. No I/O and no
// Date.now(), which is what lets the open-span clamp be tested at a fixed
// instant instead of against a moving one.
export function buildTimeline(
  raw: Span[],
  events: StreamEvent[],
  requested: Span,
  now: number,
): TimelineBody {
  // The window stops at the present. Without this the hours of today that have
  // not happened yet come back as one large gap and the app reports a
  // multi-hour outage that did not occur - the mirror image of hiding a real
  // one. The browser sends the whole local day and draws [to, midnight) as a
  // third state from the `to` reported here, so "has this elapsed?" is decided
  // by the server's clock, never by a browser clock that may be minutes off.
  const window: Span = { start: requested.start, end: Math.min(requested.end, now) }

  // No clampToNow() call here, and that is deliberate rather than an omission.
  // The invariant it enforces - MediaMTX keeps reporting a duration for the
  // segment it is still writing, and unclamped, half a recorded hour reads as a
  // fully covered one (docs/ARCHITECTURE.md item 4) - is enforced one line
  // above instead, and more strongly: the window itself ends at `now`, so a
  // span overshooting the present is clipped to it below and the denominator
  // counts only elapsed time. Calling clampToNow as well changes no output any
  // test can observe, and a redundant guard is one nobody maintains. If the
  // window clamp is ever relaxed, this is the line to put back.

  // gaps() runs merge() and this same overlap predicate internally, so these
  // spans and those gaps tile [window.start, window.end) exactly - no overlap,
  // no hole. Clipping is what keeps a span that started yesterday from
  // overflowing the bar the browser draws.
  //
  // Note for the clip route (build order step 8): resolve() returns an index
  // into the UNFILTERED merged list, which this one is not. Resolve against the
  // same filtered-and-clipped list, or key off a span's start instead.
  const spans = merge(raw)
    .filter((s) => s.end > window.start && s.start < window.end)
    .map((s) => ({ start: Math.max(s.start, window.start), end: Math.min(s.end, window.end) }))

  // TOLERANCE_MS applies only BETWEEN spans inside merge(); the leading and
  // trailing gaps gaps() emits at the window's edges are produced for any
  // positive difference at all. A day whose first segment starts at
  // 00:00:00.300 would otherwise open with a durationSec: 0 hole - the muxer
  // confetti of docs/ARCHITECTURE.md item 2, reappearing where it was never
  // tested. Suppressing them leaves `coverage` a hair under 1 with an empty
  // gaps array, which is honest: coverage is exact, the gap list is what a
  // human is meant to read.
  const holes = gaps(raw, window).filter((g) => g.end - g.start > TOLERANCE_MS)

  return {
    window: { from: iso(window.start), to: iso(window.end) },
    spans: spans.map((s) => ({
      start: iso(s.start),
      end: iso(s.end),
      durationSec: durationSec(s),
    })),
    gaps: holes.map((g) => ({
      start: iso(g.start),
      end: iso(g.end),
      durationSec: durationSec(g),
      cause: inferCause(g, events),
    })),
    coverage: coverage(raw, window),
    ...overshoot(raw, requested, window, now),
  }
}

// SPEC 8 item 4 surfaced rather than swallowed: how far MediaMTX's reported
// durations run past the present. Because the window above already stops at
// `now`, this never moves `coverage` - it is a statement about the recorder's
// honesty, not about the footage, which is why it is an optional field outside
// the SPEC 4.4 contract rather than part of it.
function overshoot(raw: Span[], requested: Span, window: Span, now: number) {
  // Only when the window actually reaches the present. What the open segment
  // claims about the future says nothing about last Tuesday, and reporting it
  // there would be a false alarm on a view that is entirely settled.
  if (requested.end < now) return {}

  // Merged, so the count matches the population of the `spans` array above and
  // two overlapping timespans cannot have their overshoot counted twice.
  const overshooting = merge(raw).filter(
    (s) => s.end > window.start && s.start < window.end && s.end > now,
  )

  const excessMs = overshooting.reduce((n, s) => n + (s.end - now), 0)

  // The same 2s that separates a muxer artefact from a real hole. The open
  // segment's reported end lands a few hundred ms either side of `now` on
  // essentially every request, and `excessSec: 0` is a discrepancy field
  // announcing that there is no discrepancy.
  if (excessMs <= TOLERANCE_MS) return {}

  return { clamped: { spanCount: overshooting.length, excessSec: Math.round(excessMs / 1000) } }
}

export const recordingsRoute = new Hono<SessionEnv>().get(
  '/:slug/timeline',
  requireSession,
  zValidator('param', slugParam, (result, c) =>
    result.success ? undefined : c.json({ error: 'invalid_slug' }, 400),
  ),
  // The hook keeps the failure body in this codebase's { error } shape. Without
  // it zValidator answers with zod's raw safeParse result, which is both a
  // different contract from every other error here and a large $ZodError union
  // dragged into AppType for every consumer of the typed client.
  zValidator('query', timelineQuery, (result, c) =>
    result.success ? undefined : c.json({ error: 'invalid_window' }, 400),
  ),
  async (c) => {
    const { slug } = c.req.valid('param')
    const { from, to } = c.req.valid('query')

    // Read once and threaded, never called twice: two Date.now() calls a few
    // milliseconds apart would clamp the spans against one instant and the
    // window against another.
    const now = Date.now()

    // The window clamp below would collapse to nothing, and coverage() would
    // divide by zero. Nothing has been recorded in a window that has not
    // started yet, and saying so is more honest than answering 0%.
    if (from >= now) return c.json({ error: 'window_in_future' }, 400)

    if (!(await findCamera(slug))) return c.json({ error: 'unknown camera' }, 404)

    let raw: Span[]
    try {
      raw = await listTimespans(slug)
    } catch (error) {
      // The playback API answers 400 - not 404 - both for a path it does not
      // have configured and for one that has simply never recorded (verified
      // against yard_sub, which returns "lstat /recordings/yard_sub: no such
      // file or directory"). The slug has already been checked against our own
      // cameras table by this point, so 400 here means "no footage on disk",
      // which is honestly zero coverage and one window-length gap.
      if (error instanceof MediaMtxError && error.status === 400) {
        console.warn(`recordings: no recordings for ${slug} -`, error.message)
        raw = []
      } else {
        // Anything else - unreachable, 5xx, a shape MediaMTX changed - is a
        // failure to answer the question. Degrading THAT to an empty list
        // would draw a broken media server as a total outage, which is the
        // specific lie this endpoint exists to avoid.
        console.error('recordings: timespan list failed -', error)
        return c.json({ error: 'mediamtx_unreachable' }, 502)
      }
    }

    // No catch: Better Auth resolves the session against this same database, so
    // a database that cannot be reached has already answered 401 upstream.
    const events = await loadEvents(slug, from, to)

    // An operator refreshing to see whether a gap closed must not be handed the
    // answer from before it closed.
    c.header('Cache-Control', 'no-store')

    return c.json(buildTimeline(raw, events, { start: from, end: to }, now))
  },
)
