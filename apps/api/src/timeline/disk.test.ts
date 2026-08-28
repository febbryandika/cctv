import { describe, expect, it } from 'vitest'
import { bytesIn, type Segment } from './disk'

// Fixed epoch literals, never new Date('...'): this suite runs under both
// TZ=UTC and TZ=Asia/Jakarta (docs/ARCHITECTURE.md#testing) and must produce
// identical output. 2026-08-24T00:00:00Z.
const T0 = 1_787_529_600_000
const MINUTE = 60_000

const segment = (offsetMinutes: number, size: number): Segment => ({
  mtimeMs: T0 + offsetMinutes * MINUTE,
  size,
})

describe('bytesIn', () => {
  const window = { start: T0, end: T0 + 60 * MINUTE }

  it('sums only the segments closed inside the window', () => {
    const segments = [segment(-1, 100), segment(10, 200), segment(30, 300), segment(90, 400)]

    expect(bytesIn(segments, window)).toBe(500)
  })

  it('is zero for an empty directory', () => {
    expect(bytesIn([], window)).toBe(0)
  })

  // Half-open [start, end), the same convention spans use. The instant at the
  // window's end belongs to the next window, not this one - get this wrong and
  // a segment is counted twice across two adjacent days.
  it('includes the start instant and excludes the end instant', () => {
    expect(bytesIn([segment(0, 100)], window)).toBe(100)
    expect(bytesIn([segment(60, 100)], window)).toBe(0)
  })

  // A segment being written when the window opened is counted whole against the
  // window it CLOSED in. Over 24 hours that overstates by at most one segment at
  // one edge, and understating would be the worse lie: it would make a disk look
  // slower-filling than it is.
  it('counts a straddling segment whole, against the window it closed in', () => {
    const straddling = segment(1, 999)

    expect(bytesIn([straddling], { start: T0 - 10 * MINUTE, end: T0 })).toBe(0)
    expect(bytesIn([straddling], window)).toBe(999)
  })
})
