// Timeline arithmetic (docs/ARCHITECTURE.md#timeline-gaps-and-coverage).
//
// SKELETON - signatures only, so the suite in coverage.test.ts fails on its
// assertions rather than on TS2305. The bodies land in the next commit.
//
// Epoch ms UTC only - never accept a Date.

export type Span = { start: number; end: number }

export type GapCause = 'camera_down' | 'unknown'

// The timeline's view of a stream_events row. `at` is epoch ms: the Date ->
// number conversion happens once, at the repository boundary (`row.at.getTime()`).
export type StreamEvent = { kind: 'up' | 'down'; at: number }

// Segment boundaries cost a few hundred ms. Anything under 2s is a muxer
// artefact, not a hole in the record. Anything over 2s is real and shown.
export const TOLERANCE_MS = 2_000

export function merge(_spans: Span[]): Span[] {
  throw new Error('not implemented')
}

export function gaps(_spans: Span[], _window: Span): Span[] {
  throw new Error('not implemented')
}

export function coverage(_spans: Span[], _window: Span): number {
  throw new Error('not implemented')
}

export function clampToNow(_spans: Span[], _now: number): Span[] {
  throw new Error('not implemented')
}

export function resolve(
  _spans: Span[],
  _t: number,
): { spanIndex: number; offsetSec: number } | null {
  throw new Error('not implemented')
}

export function inferCause(_gap: Span, _events: StreamEvent[]): GapCause {
  throw new Error('not implemented')
}
