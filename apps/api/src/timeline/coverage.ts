// Timeline arithmetic (docs/ARCHITECTURE.md#timeline-gaps-and-coverage).
//
// Pure by design: no I/O, no database, no clock. `now` is a parameter rather
// than a Date.now() call so the open-span clamp stays testable, and every
// instant in and out of this file is epoch milliseconds UTC. Formatting to
// camera-local time happens at the render boundary, never here - a Date must
// not cross into this module.
//
// This is the code that decides whether the app tells the truth, so it is
// written for readability over speed. merge() re-runs inside gaps() and again
// inside resolve(); that is a sort of a list holding roughly one entry per
// recording interruption, and caching it would trade "every function is
// independently correct" for a speedup nobody needs.

export type Span = { start: number; end: number }

export type GapCause = 'camera_down' | 'unknown'

// The timeline's view of a stream_events row. `at` is epoch ms: the Date ->
// number conversion happens once, at the repository boundary (`row.at.getTime()`).
export type StreamEvent = { kind: 'up' | 'down'; at: number }

// Segment boundaries cost a few hundred ms. Anything under 2s is a muxer
// artefact, not a hole in the record. Anything over 2s is real and shown.
export const TOLERANCE_MS = 2_000

export function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const out: Span[] = []
  for (const cur of sorted) {
    const last = out.at(-1)
    // Math.max, not cur.end: a short span contained in a long one must not
    // truncate it and invent a gap out of the remainder.
    if (last && cur.start <= last.end + TOLERANCE_MS) last.end = Math.max(last.end, cur.end)
    // Copied, so mutating `last` above never reaches the caller's spans.
    else out.push({ ...cur })
  }
  return out
}

// Spans are half-open [start, end): the instant at a span's end already belongs
// to the gap that follows it. resolve() below matches this.
export function gaps(spans: Span[], window: Span): Span[] {
  const merged = merge(spans).filter((s) => s.end > window.start && s.start < window.end)
  const out: Span[] = []
  let cursor = window.start
  for (const s of merged) {
    if (s.start > cursor) out.push({ start: cursor, end: s.start })
    cursor = Math.max(cursor, s.end)
  }
  if (cursor < window.end) out.push({ start: cursor, end: window.end })
  return out
}

// A zero-length window divides by zero here and yields NaN. That is left
// deliberately unguarded: the caller is the one that can reject it honestly, so
// the timeline route (build order step 7) validates to > from in its Zod schema
// rather than this module papering over a request that should have been a 400.
export const coverage = (spans: Span[], window: Span) =>
  1 - gaps(spans, window).reduce((n, g) => n + (g.end - g.start), 0) / (window.end - window.start)

// MediaMTX keeps reporting a duration for the segment it is still writing, and
// that reported end can sit in the future (docs/ARCHITECTURE.md, item 4).
// Unclamped, half an hour of recording reads as a fully covered hour - the app
// claiming footage it does not have.
export function clampToNow(spans: Span[], now: number): Span[] {
  return spans
    .map((s) => ({ start: s.start, end: Math.min(s.end, now) }))
    .filter((s) => s.end > s.start)
}

// A wall-clock instant to a position in the timeline, or null when it lands in
// a gap - which is what turns a click into a 409 with the nearest span instead
// of an empty <video> (SPEC 4.5). The index is into the MERGED list, the one
// the timeline bar draws, and offsetSec keeps its fraction because that is what
// a <video> element's currentTime takes.
export function resolve(spans: Span[], t: number): { spanIndex: number; offsetSec: number } | null {
  for (const [spanIndex, span] of merge(spans).entries()) {
    if (t >= span.start && t < span.end) {
      return { spanIndex, offsetSec: (t - span.start) / 1000 }
    }
  }
  return null
}

// The other half of resolve(): when an instant lands in a gap, this is the span
// the 409 offers instead (SPEC 4.5). Distance is measured to the nearer EDGE
// rather than to the start, because an instant twenty seconds past the end of an
// hour of footage is twenty seconds from footage, not an hour.
//
// Merges first, for the same reason resolve() does - the caller must only ever
// be offered a span the timeline bar actually drew, never a fragment either side
// of a muxer boundary.
export function nearestSpan(spans: Span[], t: number): Span | null {
  let nearest: Span | null = null
  let distance = Infinity

  for (const span of merge(spans)) {
    // Zero when t is inside the span or exactly at its end; callers reach this
    // only when resolve() already said gap, so that is a boundary case, not the
    // normal one.
    const away = t < span.start ? span.start - t : Math.max(0, t - span.end)

    // <=, not <: merge() returns spans sorted by start, so an equal distance
    // keeps the later one. A click dead centre in a gap resolves forward, which
    // is what "resume from here" means to someone scrubbing a timeline.
    if (away <= distance) {
      nearest = span
      distance = away
    }
  }

  return nearest
}

// The poller only writes transitions, and only every 10s, so a `down` lands a
// few seconds after the stream actually stopped - just inside the gap it
// explains. A gap shorter than that interval closes before the poller can see
// it and stays `unknown`, which is the honest answer: per SPEC 4.4 `unknown` is
// the interesting one, and inventing a cause here is the dishonesty this module
// exists to prevent.
export function inferCause(gap: Span, events: StreamEvent[]): GapCause {
  const wentDown = events.some((e) => e.kind === 'down' && e.at >= gap.start && e.at < gap.end)
  return wentDown ? 'camera_down' : 'unknown'
}
