import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaMtxError } from '../mediamtx/client'
import type * as MediaMtxClient from '../mediamtx/client'
import type * as Disk from './disk'
import { dailyCoverage } from '../db/schema'
import {
  buildRow,
  dayWindow,
  daysToSnapshot,
  localDay,
  localMidnightMs,
  msUntilNextRun,
  runSnapshot,
  shiftDay,
  snapshotCamera,
  snapshotDay,
} from './snapshot'
import type { Segment } from './disk'
import type { Span } from './coverage'

// Three mocks, one reason each:
//   ../db                importing it for real opens a postgres pool at module
//                        load. ../db/schema is imported for REAL, because the
//                        upsert target is asserted against the actual columns -
//                        a mocked schema would let a typo pass.
//   ../mediamtx/client   no test may depend on a running MediaMTX.
//   ./disk               no test may depend on a recordings directory.
// importOriginal on the client mock because snapshotCamera branches on
// `instanceof MediaMtxError`.
const { insert, upserts, failNext } = vi.hoisted(() => {
  const upserts: { values: Record<string, unknown>; target: unknown; set: unknown }[] = []
  const failNext = { on: false }

  const insert = vi.fn(() => ({
    values: vi.fn((values: Record<string, unknown>) => ({
      onConflictDoUpdate: vi.fn((config: { target: unknown; set: unknown }) => {
        if (failNext.on) {
          failNext.on = false
          return Promise.reject(new Error('upsert failed'))
        }
        upserts.push({ values, target: config.target, set: config.set })
        return Promise.resolve([])
      }),
    })),
  }))

  return { insert, upserts, failNext }
})

const { select, cameraRows } = vi.hoisted(() => {
  const cameraRows: { slug: string }[] = []
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(cameraRows)) })),
  }))
  return { select, cameraRows }
})
vi.mock('../db', () => ({ db: { insert, select } }))

const { listTimespans } = vi.hoisted(() => ({ listTimespans: vi.fn() }))
vi.mock('../mediamtx/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaMtxClient>()),
  listTimespans,
}))

const { listSegments } = vi.hoisted(() => ({ listSegments: vi.fn() }))
vi.mock('./disk', async (importOriginal) => ({
  ...(await importOriginal<typeof Disk>()),
  listSegments,
}))

// Every fixture is a fixed epoch integer, never new Date('...'). The suite runs
// under TZ=UTC and TZ=Asia/Jakarta (docs/ARCHITECTURE.md#testing) and every
// expectation below must hold identically in both - which is only possible
// because each call names its zone rather than inheriting the process's.
const JAKARTA = 'Asia/Jakarta'
const UTC = 'UTC'

const AUG_24_UTC = 1_787_529_600_000 // 2026-08-24T00:00:00Z
const AUG_24_WIB = 1_787_504_400_000 // 2026-08-24T00:00+07:00 = 2026-08-23T17:00Z
const AUG_25_WIB = 1_787_590_800_000 // 2026-08-25T00:00+07:00
const MINUTE = 60_000
const HOUR = 3_600_000

beforeEach(() => {
  upserts.length = 0
  cameraRows.length = 0
  failNext.on = false
  insert.mockClear()
  select.mockClear()
  listTimespans.mockReset()
  listSegments.mockReset().mockResolvedValue([])
})

describe('the camera-local calendar', () => {
  it('names the day an instant falls in, per zone', () => {
    // The same instant, two zones, two days - which is the whole reason the
    // zone is a parameter. 17:00Z is already tomorrow in WIB.
    expect(localDay(AUG_24_UTC, UTC)).toBe('2026-08-24')
    expect(localDay(AUG_24_WIB, JAKARTA)).toBe('2026-08-24')
    expect(localDay(AUG_24_WIB, UTC)).toBe('2026-08-23')
  })

  it('resolves a day to the instant it begins', () => {
    expect(localMidnightMs('2026-08-24', UTC)).toBe(AUG_24_UTC)
    expect(localMidnightMs('2026-08-24', JAKARTA)).toBe(AUG_24_WIB)
  })

  it('steps days across a month boundary', () => {
    expect(shiftDay('2026-08-31', 1, JAKARTA)).toBe('2026-09-01')
    expect(shiftDay('2026-09-01', -1, JAKARTA)).toBe('2026-08-31')
    expect(shiftDay('2026-08-24', 7, UTC)).toBe('2026-08-31')
  })

  it('gives a day as a half-open window exactly 24 hours long', () => {
    const window = dayWindow('2026-08-24', JAKARTA)

    expect(window).toEqual({ start: AUG_24_WIB, end: AUG_25_WIB })
    expect(window.end - window.start).toBe(24 * HOUR)
  })
})

describe('msUntilNextRun', () => {
  it('aims at 00:15 today when it has not happened yet', () => {
    // 00:05 camera-local: ten minutes to go.
    expect(msUntilNextRun(AUG_24_WIB + 5 * MINUTE, JAKARTA)).toBe(10 * MINUTE)
  })

  it('aims at tomorrow once 00:15 has passed', () => {
    // 00:20 camera-local, so the next run is 23h55m away.
    expect(msUntilNextRun(AUG_24_WIB + 20 * MINUTE, JAKARTA)).toBe(24 * HOUR - 5 * MINUTE)
  })

  it('never returns zero or a negative delay at the boundary', () => {
    // Exactly 00:15 is already past today's run, so it must roll forward - a
    // zero delay would spin setTimeout in a tight loop for the whole minute.
    expect(msUntilNextRun(AUG_24_WIB + 15 * MINUTE, JAKARTA)).toBe(24 * HOUR)
  })
})

describe('buildRow', () => {
  const window: Span = { start: AUG_24_WIB, end: AUG_25_WIB }
  const full: Span[] = [{ start: AUG_24_WIB, end: AUG_25_WIB }]

  it('reports a fully covered day', () => {
    expect(buildRow(full, [], window)).toEqual({
      coverage: 1,
      gapCount: 0,
      longestGapSec: 0,
      bytesWritten: 0,
    })
  })

  it('counts a real hole and measures the longest one', () => {
    const spans: Span[] = [
      { start: AUG_24_WIB, end: AUG_24_WIB + 6 * HOUR },
      { start: AUG_24_WIB + 7 * HOUR, end: AUG_24_WIB + 8 * HOUR },
      { start: AUG_24_WIB + 10 * HOUR, end: AUG_25_WIB },
    ]

    expect(buildRow(spans, [], window)).toEqual({
      coverage: 1 - 3 / 24,
      gapCount: 2,
      longestGapSec: 2 * 3600,
      bytesWritten: 0,
    })
  })

  // A hole shorter than a muxer boundary is not a hole. merge() absorbs it
  // INSIDE the day, so coverage is exactly 1 and there is nothing to report.
  it('absorbs a sub-tolerance hole between two spans', () => {
    const spans: Span[] = [
      { start: AUG_24_WIB, end: AUG_24_WIB + 12 * HOUR },
      { start: AUG_24_WIB + 12 * HOUR + 1_500, end: AUG_25_WIB },
    ]

    expect(buildRow(spans, [], window)).toMatchObject({
      coverage: 1,
      gapCount: 0,
      longestGapSec: 0,
    })
  })

  // At the EDGES it is different, and this is the asymmetry worth pinning down.
  // TOLERANCE_MS applies only between spans inside merge(); gaps() emits a
  // leading or trailing hole for any positive difference at all. So `coverage`
  // sits a hair under 1 while gapCount is 0 - which is honest, because coverage
  // is exact and the gap count is what a human reads. Never re-derive one from
  // the other.
  it('leaves coverage a hair under 1 for a sub-tolerance hole at the edge', () => {
    const spans: Span[] = [{ start: AUG_24_WIB + 1_500, end: AUG_25_WIB }]
    const row = buildRow(spans, [], window)

    expect(row.gapCount).toBe(0)
    expect(row.longestGapSec).toBe(0)
    expect(row.coverage).toBeLessThan(1)
    expect(row.coverage).toBeGreaterThan(0.9999)
  })

  it('weighs only the segments that closed inside the day', () => {
    const segments: Segment[] = [
      { mtimeMs: AUG_24_WIB - MINUTE, size: 111 },
      { mtimeMs: AUG_24_WIB + HOUR, size: 222 },
      { mtimeMs: AUG_25_WIB, size: 333 },
    ]

    expect(buildRow(full, segments, window).bytesWritten).toBe(222)
  })

  // The property the nightly job depends on: same inputs, same row, so an
  // upsert that re-runs a day cannot change what that day says.
  it('is deterministic', () => {
    const spans: Span[] = [{ start: AUG_24_WIB + HOUR, end: AUG_24_WIB + 20 * HOUR }]
    const segments: Segment[] = [{ mtimeMs: AUG_24_WIB + 2 * HOUR, size: 4_096 }]

    expect(buildRow(spans, segments, window)).toEqual(buildRow(spans, segments, window))
  })
})

describe('daysToSnapshot', () => {
  const now = AUG_25_WIB + 15 * MINUTE // 00:15 on the 25th, camera-local

  it('writes nothing when there is no footage at all', () => {
    // A fresh install must not back-fill `coverage: 0` for days before it
    // existed. daily_coverage is the honest record; a fabricated outage in it
    // is worse than a missing row.
    expect(daysToSnapshot(null, now, JAKARTA)).toEqual([])
  })

  // The load-bearing one. recordDeleteAfter deletes oldest-first, so exactly one
  // day is half-erased at any moment; snapshotting it would overwrite the
  // accurate row written when that day was whole.
  it('skips the earliest day, which retention has already half-erased', () => {
    const earliest = AUG_24_WIB + 12 * HOUR // mid-day on the 24th

    expect(daysToSnapshot(earliest, now, JAKARTA)).toEqual([])
  })

  it('runs from the day after the earliest footage through yesterday', () => {
    const earliest = AUG_24_WIB - 3 * 24 * HOUR + 12 * HOUR // mid-day on the 21st

    expect(daysToSnapshot(earliest, now, JAKARTA)).toEqual([
      '2026-08-22',
      '2026-08-23',
      '2026-08-24',
    ])
  })

  it('stops at yesterday - today is still being recorded', () => {
    const days = daysToSnapshot(AUG_24_WIB - 30 * 24 * HOUR, now, JAKARTA)

    expect(days.at(-1)).toBe('2026-08-24')
    expect(days).not.toContain('2026-08-25')
  })

  it('caps a very long history at the most recent 31 days', () => {
    const days = daysToSnapshot(AUG_24_WIB - 400 * 24 * HOUR, now, JAKARTA)

    expect(days).toHaveLength(31)
    expect(days.at(-1)).toBe('2026-08-24')
  })
})

describe('snapshotDay', () => {
  const row = { coverage: 0.98, gapCount: 2, longestGapSec: 900, bytesWritten: 27_000_000_000 }

  it('upserts against the (camera_slug, day) constraint', async () => {
    await snapshotDay('yard', '2026-08-24', row)

    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.values).toEqual({ cameraSlug: 'yard', day: '2026-08-24', ...row })
    // The constraint is what makes this idempotent, so the target is asserted
    // against the real columns rather than against a string.
    expect(upserts[0]?.target).toEqual([dailyCoverage.cameraSlug, dailyCoverage.day])
    expect(upserts[0]?.set).toEqual(row)
  })

  // The requirement, stated as a test: idempotent via the constraint, never by
  // reading first. A check-then-insert is wrong under a concurrent second run
  // AND costs a query on the Neon compute idle_timeout exists to let sleep.
  it('never reads before it writes', async () => {
    await snapshotDay('yard', '2026-08-24', row)

    expect(select).not.toHaveBeenCalled()
  })

  it('re-running a day issues a second upsert with an identical payload', async () => {
    await snapshotDay('yard', '2026-08-24', row)
    await snapshotDay('yard', '2026-08-24', row)

    expect(upserts).toHaveLength(2)
    expect(upserts[0]).toEqual(upserts[1])
    expect(select).not.toHaveBeenCalled()
  })
})

describe('snapshotCamera', () => {
  const now = AUG_25_WIB + 15 * MINUTE

  // Days are asserted through the module's own calendar rather than as literals:
  // this function reads the PROCESS zone, so a hardcoded '2026-08-24' would pass
  // under TZ=UTC and fail under TZ=Asia/Jakarta. The calendar itself is pinned
  // against explicit zones further up; what is asserted here is the shape.
  it('reads MediaMTX and the disk once, then writes one row per day', async () => {
    listTimespans.mockResolvedValue([
      { start: AUG_24_WIB - 2 * 24 * HOUR, end: AUG_25_WIB },
    ] satisfies Span[])

    await snapshotCamera('yard', now)

    // Once each, whatever the number of days - a per-day scan would walk the
    // same directory once per day for the same bytes.
    expect(listTimespans).toHaveBeenCalledTimes(1)
    expect(listSegments).toHaveBeenCalledTimes(1)

    const days = upserts.map((u) => u.values.day)
    expect(days).toHaveLength(2)
    expect(days.at(-1)).toBe(shiftDay(localDay(now), -1))
    expect([...days].sort()).toEqual(days)
  })

  it('writes nothing when the path has never recorded', async () => {
    // The playback API answers 400 - not 404 - for a path with no recordings.
    listTimespans.mockRejectedValue(new MediaMtxError('no recordings', { status: 400 }))

    await snapshotCamera('yard', now)

    expect(upserts).toHaveLength(0)
    expect(listSegments).not.toHaveBeenCalled()
  })

  // A failure to ASK must never be recorded as a bad night. Writing coverage: 0
  // here would blame the camera for the API server's own blindness - the same
  // distinction the poller draws between `down` and "we could not tell".
  it('rethrows anything that is not a 400, rather than recording zero coverage', async () => {
    listTimespans.mockRejectedValue(new MediaMtxError('unreachable'))

    await expect(snapshotCamera('yard', now)).rejects.toThrow('unreachable')
    expect(upserts).toHaveLength(0)
  })
})

describe('runSnapshot', () => {
  const now = AUG_25_WIB + 15 * MINUTE
  const yesterday = [{ start: AUG_24_WIB - 2 * 24 * HOUR, end: AUG_25_WIB }]

  it('one camera failing does not abort the next', async () => {
    cameraRows.push({ slug: 'yard' }, { slug: 'gate' })
    listTimespans.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(yesterday)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runSnapshot(now)

    expect(upserts.length).toBeGreaterThan(0)
    expect(upserts.every((u) => u.values.cameraSlug === 'gate')).toBe(true)
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  // It runs from a timer. An unhandled rejection there would take down a
  // process whose other job is serving video.
  it('never rejects when the write itself fails', async () => {
    cameraRows.push({ slug: 'yard' })
    listTimespans.mockResolvedValue(yesterday)
    failNext.on = true
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runSnapshot(now)).resolves.toBeUndefined()

    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})
