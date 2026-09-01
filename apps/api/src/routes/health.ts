import { and, gte, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { db } from '../db'
import { cameras, dailyCoverage } from '../db/schema'
import { listPaths, listTimespans, MediaMtxError, type MediaMtxPath } from '../mediamtx/client'
import { subscribe } from '../mediamtx/poller'
import { requireSession, type SessionEnv } from '../middleware/session'
import { coverage, gaps, TOLERANCE_MS, type Span } from '../timeline/coverage'
import { bytesIn, diskSpace, listSegments, type Segment } from '../timeline/disk'

// "Is this healthy right now, and will the disk last?" - the two questions the
// timeline cannot answer (docs/ARCHITECTURE.md#observability). No Prometheus and
// no metrics library: seven cameras on one machine do not need a metrics stack,
// and everything here is a read the app was already able to do.

const WINDOW_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 3_600_000

// Long enough to be cheap, short enough that a page left open overnight does not
// die behind an idle-timeout proxy, and short enough that an abandoned stream's
// pending timer clears promptly.
const KEEPALIVE_MS = 15_000

// Two weeks reads as a trend without becoming a wall of numbers. daily_coverage
// keeps rows forever - it outlives the footage on purpose - so this is a display
// bound, not a retention one.
const HISTORY_DAYS = 14

// The epoch-ms -> RFC3339 boundary for the response, and the only one in this
// file. Camera-local formatting happens in the browser, which is the render
// boundary (docs/ARCHITECTURE.md#timeline-gaps-and-coverage).
const iso = (ms: number) => new Date(ms).toISOString()

export type HistoryRow = {
  day: string
  coverage: number
  gapCount: number
  longestGapSec: number
  bytesWritten: number | null
}

export type CameraReading = {
  slug: string
  name: string
  enabled: boolean
  // null means MediaMTX could not answer, which is NOT the same as no footage
  // (that is []). The difference decides whether coverage is a number or null.
  raw: Span[] | null
  segments: Segment[]
  history: HistoryRow[]
}

export type HealthBody = {
  checkedAt: string
  mediamtx: 'up' | 'down'
  disk: {
    freeBytes: number | null
    totalBytes: number | null
    bytesPerHour: number
    daysRemaining: number | null
  }
  cameras: {
    slug: string
    name: string
    enabled: boolean
    online: boolean
    coverage24h: number | null
    gapCount: number | null
    longestGapSec: number | null
    bytesWritten24h: number
    history: HistoryRow[]
  }[]
}

/**
 * Days of disk left, projected from bytes actually written.
 *
 * MEASURED, never recordDeleteAfter. A retention setting nobody checked against
 * a real bitrate is a guess, and the specific failure this number exists to
 * catch is a camera whose bitrate drifted up until the disk fills days before
 * the configured window expires (docs/ARCHITECTURE.md#measurement).
 *
 * null rather than Infinity when nothing is being written: "no footage, so no
 * projection" is the honest answer, and Infinity does not survive JSON.
 */
export function project(
  freeBytes: number | null,
  bytesWritten: number,
  windowMs: number,
): { bytesPerHour: number; daysRemaining: number | null } {
  const bytesPerHour = windowMs > 0 ? bytesWritten / (windowMs / HOUR_MS) : 0
  const bytesPerDay = bytesPerHour * 24

  return {
    bytesPerHour,
    daysRemaining: freeBytes !== null && bytesPerDay > 0 ? freeBytes / bytesPerDay : null,
  }
}

/**
 * Pure: readings, paths and a window in, response body out. No I/O and no
 * Date.now(), the same shape routes/cameras.ts's joinStatus and
 * routes/recordings.ts's buildTimeline take, and for the same reason - it is
 * testable with no network and no mocking.
 */
export function buildHealth(
  readings: CameraReading[],
  paths: MediaMtxPath[] | null,
  disk: { freeBytes: number; totalBytes: number } | null,
  window: Span,
): HealthBody {
  const byName = new Map((paths ?? []).map((path) => [path.name, path]))

  const perCamera = readings.map((reading) => {
    // `ready`, never `online`. MediaMTX reports online: true for an idle
    // on-demand path, so `online` would call a camera that has been down for
    // hours live; it is deliberately absent from the Zod schema in client.ts.
    const online = byName.get(reading.slug)?.ready ?? false

    // Sub-tolerance holes are muxer boundaries, not gaps - the same filter
    // routes/recordings.ts applies. `coverage` stays exact and is never
    // re-derived from the gap list, so it can sit a hair under 1 with zero gaps.
    const holes =
      reading.raw === null
        ? null
        : gaps(reading.raw, window).filter((g) => g.end - g.start > TOLERANCE_MS)

    return {
      slug: reading.slug,
      name: reading.name,
      enabled: reading.enabled,
      online,
      coverage24h: reading.raw === null ? null : coverage(reading.raw, window),
      gapCount: holes === null ? null : holes.length,
      longestGapSec:
        holes === null
          ? null
          : Math.round(holes.reduce((longest, g) => Math.max(longest, g.end - g.start), 0) / 1000),
      // From the filesystem, so it is a real number even when MediaMTX cannot
      // be reached. The disk does not stop being full because the API is down.
      bytesWritten24h: bytesIn(reading.segments, window),
      history: reading.history,
    }
  })

  const written = perCamera.reduce((total, camera) => total + camera.bytesWritten24h, 0)

  return {
    checkedAt: iso(window.end),
    // "this camera is down" and "we could not tell" are different facts, and
    // saying which is the entire point of this project.
    mediamtx: paths === null ? 'down' : 'up',
    disk: {
      freeBytes: disk?.freeBytes ?? null,
      totalBytes: disk?.totalBytes ?? null,
      ...project(disk?.freeBytes ?? null, written, window.end - window.start),
    },
    cameras: perCamera,
  }
}

// Same degradation as routes/recordings.ts: the playback API answers 400 both
// for a path it does not have and for one that has never recorded, which is
// honestly zero footage. Anything else is a failure to answer the question, and
// drawing that as a total outage is the specific lie this endpoint avoids.
async function loadTimespans(slug: string): Promise<Span[] | null> {
  try {
    return await listTimespans(slug)
  } catch (error) {
    if (error instanceof MediaMtxError && error.status === 400) {
      console.warn(`health: no recordings for ${slug} -`, error.message)
      return []
    }

    console.error('health: timespan list failed -', error)
    return null
  }
}

// One query for every camera, which is what the per-camera version said to do
// here once N grew past one. The shape is deliberate in two ways.
//
// The lower bound is a UTC date two days wider than HISTORY_DAYS. `day` is a
// camera-local calendar day written by timeline/snapshot.ts and this file does
// not own that zone, so the bound is only ever used to keep the scan small -
// the actual selection is the per-camera slice by COUNT below, which no zone
// can shift. Widening rather than converting is what keeps every calendar
// decision inside snapshot.ts, where it is tested under both zones.
//
// And the trim is per camera, because the old LIMIT was: one query with a
// global LIMIT would return fourteen rows in total and leave six cameras blank.
async function loadHistory(slugs: string[], now: number): Promise<Map<string, HistoryRow[]>> {
  const history = new Map<string, HistoryRow[]>()
  if (slugs.length === 0) return history

  const from = new Date(now - (HISTORY_DAYS + 2) * 86_400_000).toISOString().slice(0, 10)

  const rows = await db
    .select({
      cameraSlug: dailyCoverage.cameraSlug,
      day: dailyCoverage.day,
      coverage: dailyCoverage.coverage,
      gapCount: dailyCoverage.gapCount,
      longestGapSec: dailyCoverage.longestGapSec,
      bytesWritten: dailyCoverage.bytesWritten,
    })
    .from(dailyCoverage)
    .where(and(inArray(dailyCoverage.cameraSlug, slugs), gte(dailyCoverage.day, from)))
    // Oldest-first, so the browser can draw it left to right and the slice
    // below takes the newest end.
    .orderBy(dailyCoverage.cameraSlug, dailyCoverage.day)

  for (const { cameraSlug, ...row } of rows) {
    history.set(cameraSlug, [...(history.get(cameraSlug) ?? []), row])
  }

  for (const [slug, rowsForCamera] of history) {
    history.set(slug, rowsForCamera.slice(-HISTORY_DAYS))
  }

  return history
}

export const healthRoute = new Hono<SessionEnv>()
  .get('/', requireSession, async (c) => {
    const now = Date.now()
    const window: Span = { start: now - WINDOW_MS, end: now }

    // Columns named one by one, not select(): rtsp_main and rtsp_sub are the
    // camera's stream URLs and carry its credentials
    // (docs/ARCHITECTURE.md#the-trust-boundary), so a select() here would put a
    // password one JSON.stringify from the browser.
    const rows = await db
      .select({ slug: cameras.slug, name: cameras.name, enabled: cameras.enabled })
      .from(cameras)
      .orderBy(cameras.name)

    // A MediaMTX that cannot be reached must not take the health page down with
    // it - the page exists to be readable exactly when something is wrong.
    const paths = await listPaths().catch((error: unknown) => {
      console.error('health: control API unreachable -', error)
      return null
    })

    // Parallel, not sequential. At one camera the difference was invisible; at
    // seven, three serial awaits each - a MediaMTX call with a 3s deadline, a
    // directory scan, and a query - is 21 round-trips and a health page that
    // can take twenty seconds to say the disk is full.
    //
    // Safe because every branch already degrades rather than throws:
    // loadTimespans answers null on any failure and listSegments swallows its
    // own, so there is no rejection for Promise.all to short-circuit on. And
    // the history query has left the loop, which is what keeps this off the
    // max: 5 connection pool - a seven-way parallel query fan-out would have
    // queued on it.
    const historyBySlug = await loadHistory(
      rows.map((row) => row.slug),
      now,
    )

    const [readings, disk] = await Promise.all([
      Promise.all(
        rows.map(async (row): Promise<CameraReading> => {
          const [raw, segments] = await Promise.all([
            loadTimespans(row.slug),
            listSegments(row.slug),
          ])
          return { ...row, raw, segments, history: historyBySlug.get(row.slug) ?? [] }
        }),
      ),
      diskSpace(),
    ])

    // Every number here is a measurement of this instant; a cached one would be
    // a health page reporting how things were.
    c.header('Cache-Control', 'no-store')
    return c.json(buildHealth(readings, paths, disk, window))
  })

  // Transitions as they happen, so a watching operator sees a drop when it
  // occurs rather than at the next refetch (docs/ARCHITECTURE.md#observability).
  // The poller is in THIS process, which is what makes an in-process
  // subscription enough and a broker unnecessary.
  .get('/events', requireSession, (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = subscribe((event) => {
        // Fire and forget: StreamingApi.write swallows its own errors, so a dead
        // socket cannot reject here. onAbort below is what actually cleans up.
        void stream.writeSSE({
          event: 'transition',
          data: JSON.stringify({ ...event, at: iso(event.at) }),
        })
      })

      // The clean close. Bun cancels the response body when the browser goes
      // away, which aborts the stream, which fires this - so a closed tab
      // removes its listener immediately rather than at the next keepalive.
      stream.onAbort(unsubscribe)

      // One frame straight away so the headers flush and EventSource fires
      // `open`. Without it the browser holds a connection that has produced no
      // bytes and reports nothing at all.
      await stream.writeSSE({ event: 'open', data: iso(Date.now()) })

      while (!stream.aborted) {
        await stream.sleep(KEEPALIVE_MS)
        if (stream.aborted) break
        await stream.writeSSE({ event: 'ping', data: '' })
      }

      // Belt and braces: onAbort has almost certainly run already, and
      // Set.delete is idempotent.
      unsubscribe()
    }),
  )
