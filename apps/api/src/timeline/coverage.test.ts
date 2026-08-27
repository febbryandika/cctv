import { describe, expect, it } from 'vitest'
import {
  clampToNow,
  coverage,
  gaps,
  inferCause,
  merge,
  resolve,
  TOLERANCE_MS,
  type Span,
} from './coverage'

// 2026-08-25T00:00:00Z. In Asia/Jakarta (UTC+7, no DST) the same instant is
// 07:00 local, so any code that parses a wall-clock string as local time when it
// meant UTC shifts every number below by exactly 25_200_000 ms and these
// assertions stop matching. That is the bug this file exists to catch, and it is
// why nothing here is computed with `new Date(...)` - an expectation built the
// same wrong way as the code would agree with it in every timezone.
const BASE = 1787616000000

const SECOND = 1_000
const MINUTE = 60_000
const HOUR = 3_600_000

// One hour starting at BASE. Most gap cases are read against this.
const WINDOW: Span = { start: BASE, end: BASE + HOUR }

describe('merge', () => {
  // The three tolerance cases are the reason this module is tested first. Too
  // small and the timeline is confetti-ed with muxer artefacts; too large and
  // real gaps disappear.
  it('merges two spans separated by exactly TOLERANCE_MS', () => {
    const result = merge([
      { start: BASE, end: BASE + MINUTE },
      { start: BASE + MINUTE + TOLERANCE_MS, end: BASE + 2 * MINUTE },
    ])

    expect(result).toEqual([{ start: BASE, end: BASE + 2 * MINUTE }])
  })

  it('merges a separation just under TOLERANCE_MS', () => {
    const result = merge([
      { start: BASE, end: BASE + MINUTE },
      { start: BASE + MINUTE + TOLERANCE_MS - 1, end: BASE + 2 * MINUTE },
    ])

    expect(result).toEqual([{ start: BASE, end: BASE + 2 * MINUTE }])
  })

  it('keeps two spans separated by just over TOLERANCE_MS', () => {
    const result = merge([
      { start: BASE, end: BASE + MINUTE },
      { start: BASE + MINUTE + TOLERANCE_MS + 1, end: BASE + 2 * MINUTE },
    ])

    expect(result).toEqual([
      { start: BASE, end: BASE + MINUTE },
      { start: BASE + MINUTE + TOLERANCE_MS + 1, end: BASE + 2 * MINUTE },
    ])
  })

  it('sorts unsorted input before merging', () => {
    const result = merge([
      { start: BASE + HOUR, end: BASE + 2 * HOUR },
      { start: BASE, end: BASE + MINUTE },
    ])

    expect(result).toEqual([
      { start: BASE, end: BASE + MINUTE },
      { start: BASE + HOUR, end: BASE + 2 * HOUR },
    ])
  })

  it('merges overlapping spans', () => {
    const result = merge([
      { start: BASE, end: BASE + 2 * MINUTE },
      { start: BASE + MINUTE, end: BASE + 3 * MINUTE },
    ])

    expect(result).toEqual([{ start: BASE, end: BASE + 3 * MINUTE }])
  })

  // The end must take the later of the two, not simply the newer one: a short
  // span arriving second would otherwise truncate an hour-long span to a minute
  // and invent 59 minutes of gap.
  it('absorbs a span fully contained in another without shortening it', () => {
    const result = merge([
      { start: BASE, end: BASE + HOUR },
      { start: BASE + MINUTE, end: BASE + 2 * MINUTE },
    ])

    expect(result).toEqual([{ start: BASE, end: BASE + HOUR }])
  })

  it('returns nothing for no spans', () => {
    expect(merge([])).toEqual([])
  })

  // merge() walks a copy and mutates only what it pushed. Mutating the caller's
  // spans would corrupt the raw MediaMTX timespans every later call reads.
  it('does not mutate its input', () => {
    const input = [
      { start: BASE, end: BASE + MINUTE },
      { start: BASE + MINUTE + 500, end: BASE + 2 * MINUTE },
    ]

    merge(input)

    expect(input).toEqual([
      { start: BASE, end: BASE + MINUTE },
      { start: BASE + MINUTE + 500, end: BASE + 2 * MINUTE },
    ])
  })
})

describe('gaps', () => {
  it('clips a span that starts before the window and reports no leading gap', () => {
    const result = gaps([{ start: BASE - 10 * MINUTE, end: BASE + 5 * MINUTE }], WINDOW)

    expect(result).toEqual([{ start: BASE + 5 * MINUTE, end: BASE + HOUR }])
  })

  it('clips a span that ends after the window and reports no trailing gap', () => {
    const result = gaps([{ start: BASE + 50 * MINUTE, end: BASE + 2 * HOUR }], WINDOW)

    expect(result).toEqual([{ start: BASE, end: BASE + 50 * MINUTE }])
  })

  it('reports the whole window as one gap when it contains no spans', () => {
    expect(gaps([], WINDOW)).toEqual([{ start: BASE, end: BASE + HOUR }])
  })

  it('reports no gaps for a fully covered window', () => {
    const result = gaps([{ start: BASE - MINUTE, end: BASE + HOUR + MINUTE }], WINDOW)

    expect(result).toEqual([])
  })

  it('reports holes before, between, and after the spans', () => {
    const result = gaps(
      [
        { start: BASE + 10 * MINUTE, end: BASE + 20 * MINUTE },
        { start: BASE + 30 * MINUTE, end: BASE + 40 * MINUTE },
      ],
      WINDOW,
    )

    expect(result).toEqual([
      { start: BASE, end: BASE + 10 * MINUTE },
      { start: BASE + 20 * MINUTE, end: BASE + 30 * MINUTE },
      { start: BASE + 40 * MINUTE, end: BASE + HOUR },
    ])
  })

  it('ignores spans that fall entirely outside the window', () => {
    const result = gaps(
      [
        { start: BASE - 2 * HOUR, end: BASE - HOUR },
        { start: BASE + 2 * HOUR, end: BASE + 3 * HOUR },
      ],
      WINDOW,
    )

    expect(result).toEqual([{ start: BASE, end: BASE + HOUR }])
  })
})

describe('coverage', () => {
  // Exactly 1 and exactly 0, not 0.9999999999 - the health page and the README
  // both print this number.
  it('is exactly 1 for a fully covered window', () => {
    expect(coverage([{ start: BASE - MINUTE, end: BASE + HOUR + MINUTE }], WINDOW)).toBe(1)
  })

  it('is exactly 0 for a window with no spans', () => {
    expect(coverage([], WINDOW)).toBe(0)
  })

  it('reports the recorded fraction of a partly covered window', () => {
    expect(coverage([{ start: BASE, end: BASE + 45 * MINUTE }], WINDOW)).toBe(0.75)
  })
})

describe('clampToNow', () => {
  // MediaMTX's reported duration for the segment it is still writing can run
  // past the present (docs/ARCHITECTURE.md#timeline-gaps-and-coverage, item 4).
  it('trims a still-open span whose reported end is in the future', () => {
    const result = clampToNow([{ start: BASE, end: BASE + HOUR }], BASE + 30 * MINUTE)

    expect(result).toEqual([{ start: BASE, end: BASE + 30 * MINUTE }])
  })

  it('leaves a span that already ended alone', () => {
    const result = clampToNow([{ start: BASE, end: BASE + 10 * MINUTE }], BASE + HOUR)

    expect(result).toEqual([{ start: BASE, end: BASE + 10 * MINUTE }])
  })

  it('drops a span that starts after now entirely', () => {
    const result = clampToNow([{ start: BASE + 2 * HOUR, end: BASE + 3 * HOUR }], BASE + HOUR)

    expect(result).toEqual([])
  })

  // The point of the clamp: without it, half an hour of recording reads as a
  // fully covered hour, which is the app lying about what it has.
  it('stops an unfinished span from reading as full coverage', () => {
    const spans = [{ start: BASE, end: BASE + HOUR }]
    const now = BASE + 30 * MINUTE

    expect(coverage(spans, WINDOW)).toBe(1)
    expect(coverage(clampToNow(spans, now), WINDOW)).toBe(0.5)
  })
})

describe('resolve', () => {
  it('returns the span index and a fractional second offset', () => {
    const result = resolve([{ start: BASE, end: BASE + HOUR }], BASE + 90 * SECOND + 500)

    expect(result).toEqual({ spanIndex: 0, offsetSec: 90.5 })
  })

  it('returns null for an instant inside a gap', () => {
    const result = resolve(
      [
        { start: BASE, end: BASE + 10 * MINUTE },
        { start: BASE + 30 * MINUTE, end: BASE + 40 * MINUTE },
      ],
      BASE + 20 * MINUTE,
    )

    expect(result).toBeNull()
  })

  it('returns null before the first span and after the last', () => {
    const spans = [{ start: BASE, end: BASE + 10 * MINUTE }]

    expect(resolve(spans, BASE - MINUTE)).toBeNull()
    expect(resolve(spans, BASE + 20 * MINUTE)).toBeNull()
  })

  // Spans are half-open: the first instant is inside, the last is already the
  // gap. gaps() emits {start: previousEnd, end: nextStart}, so anything else
  // would make resolve() and gaps() disagree about the same millisecond.
  it('treats the start of a span as inside it and the end as outside', () => {
    const spans = [{ start: BASE, end: BASE + 10 * MINUTE }]

    expect(resolve(spans, BASE)).toEqual({ spanIndex: 0, offsetSec: 0 })
    expect(resolve(spans, BASE + 10 * MINUTE)).toBeNull()
  })

  // The index is into the MERGED list - what the timeline bar actually draws -
  // so two raw spans a muxer boundary apart are one span with one index.
  it('indexes the merged list, not the raw input', () => {
    const result = resolve(
      [
        { start: BASE, end: BASE + MINUTE },
        { start: BASE + MINUTE + TOLERANCE_MS, end: BASE + 10 * MINUTE },
      ],
      BASE + 5 * MINUTE,
    )

    expect(result).toEqual({ spanIndex: 0, offsetSec: 300 })
  })
})

describe('inferCause', () => {
  const GAP: Span = { start: BASE + 10 * MINUTE, end: BASE + 20 * MINUTE }

  // The poller runs every 10s, so it records the `down` a few seconds after the
  // stream actually stopped - just inside the gap it explains.
  it('blames a gap containing a down event on the camera', () => {
    const events = [{ kind: 'down' as const, at: BASE + 10 * MINUTE + 8 * SECOND }]

    expect(inferCause(GAP, events)).toBe('camera_down')
  })

  it('leaves a gap with no events unknown', () => {
    expect(inferCause(GAP, [])).toBe('unknown')
  })

  it('leaves a gap containing only an up event unknown', () => {
    const events = [{ kind: 'up' as const, at: BASE + 15 * MINUTE }]

    expect(inferCause(GAP, events)).toBe('unknown')
  })

  it('does not let a down event outside the gap claim it', () => {
    const before = [{ kind: 'down' as const, at: BASE + 5 * MINUTE }]
    const after = [{ kind: 'down' as const, at: BASE + 25 * MINUTE }]

    expect(inferCause(GAP, before)).toBe('unknown')
    expect(inferCause(GAP, after)).toBe('unknown')
  })

  // A gap shorter than the poll interval closes before the poller can see it,
  // so there is no event to match and the honest answer is `unknown`. Per
  // SPEC 4.4 that is the interesting one - inventing a cause here is exactly
  // the dishonesty this module exists to prevent.
  it('leaves a gap shorter than the poll interval unknown', () => {
    const shortGap: Span = { start: BASE, end: BASE + 5 * SECOND }
    const events = [{ kind: 'down' as const, at: BASE + 8 * SECOND }]

    expect(inferCause(shortGap, events)).toBe('unknown')
  })
})

// SPEC 11 requires identical output under TZ=UTC and TZ=Asia/Jakarta. No
// per-test juggling is needed: CI runs this whole file twice (ci.yml matrix
// tz: [UTC, Asia/Jakarta]) and every literal below is a fixed instant, so the
// two runs must agree by construction.
describe('timezone', () => {
  // Midnight to midnight on one Jakarta calendar day: 2026-08-25T00:00:00+07:00
  // is 17:00 the previous day in UTC. A day window built from local wall-clock
  // parts is where a 7-hour slip shows up first.
  const DAY: Span = { start: 1787590800000, end: 1787677200000 }

  it('produces the same spans, gaps and coverage in either zone', () => {
    // Recorded 00:00-10:00, dropped for an hour, recording again from 11:00.
    // The open span still reports an end of 14:00 while now is 13:00.
    const spans = [
      { start: 1787590800000, end: 1787626800000 },
      { start: 1787630400000, end: 1787641200000 },
    ]
    const now = 1787637600000

    const clamped = clampToNow(spans, now)

    expect(merge(clamped)).toEqual([
      { start: 1787590800000, end: 1787626800000 },
      { start: 1787630400000, end: 1787637600000 },
    ])
    expect(gaps(clamped, DAY)).toEqual([
      { start: 1787626800000, end: 1787630400000 },
      { start: 1787637600000, end: 1787677200000 },
    ])
    expect(coverage(clamped, DAY)).toBe(0.5)
  })

  it('resolves a wall-clock instant to the same offset in either zone', () => {
    const spans = [
      { start: 1787590800000, end: 1787626800000 },
      { start: 1787630400000, end: 1787637600000 },
    ]

    // 12:00 Jakarta, one hour into the second span.
    expect(resolve(spans, 1787634000000)).toEqual({ spanIndex: 1, offsetSec: 3600 })
  })
})
