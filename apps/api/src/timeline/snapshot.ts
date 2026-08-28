import { eq } from 'drizzle-orm'
import { db } from '../db'
import { cameras, dailyCoverage } from '../db/schema'
import { listTimespans, MediaMtxError } from '../mediamtx/client'
import { coverage, gaps, TOLERANCE_MS, type Span } from './coverage'
import { bytesIn, listSegments, type Segment } from './disk'

// The long memory (docs/ARCHITECTURE.md#observability). Recordings are deleted
// after recordDeleteAfter; the record of how reliable the system was must
// outlive them, because "was last month worse than this one" is a question the
// footage itself can no longer answer.
//
// Long-lived module code started from src/server.ts, which is half the reason
// this API is its own process (docs/ARCHITECTURE.md#why-a-separate-api-server).

const RUN_AT_MS = 15 * 60_000 // 00:15 camera-local
const MAX_BACKFILL_DAYS = 31

// The zone the process actually resolves, which is what scripts/measure.ts
// reads too. NOT process.env.TZ: an env file loaded after the runtime has
// initialised its calendar would say Asia/Jakarta while Date still thinks UTC,
// and this is the one module where believing the wrong one is a seven-hour
// error in a stored row.
const CAMERA_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

// Every exported helper takes the zone as a parameter, defaulting to the
// process's. The suite must produce identical output under TZ=UTC and
// TZ=Asia/Jakarta (docs/ARCHITECTURE.md#testing), which it can only do if the
// tests can name a zone instead of inheriting one.
const dayFormatters = new Map<string, Intl.DateTimeFormat>()
const partsFormatters = new Map<string, Intl.DateTimeFormat>()

// en-CA renders YYYY-MM-DD, which is what the `day` column stores.
// toISOString().slice(0, 10) would be the UTC day, which in WIB calls the first
// seven hours of every day "yesterday".
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dayFormatters.get(timeZone)
  if (cached) return cached

  const made = new Intl.DateTimeFormat('en-CA', { timeZone })
  dayFormatters.set(timeZone, made)
  return made
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatters.get(timeZone)
  if (cached) return cached

  const made = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  partsFormatters.set(timeZone, made)
  return made
}

/** The zone's offset from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(new Date(at))
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')

  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  )

  return asIfUtc - at
}

/** The camera-local calendar day (YYYY-MM-DD) containing an instant. */
export const localDay = (at: number, timeZone = CAMERA_TZ): string =>
  dayFormatter(timeZone).format(new Date(at))

/**
 * The instant at which a camera-local calendar day begins.
 *
 * Guess UTC midnight, measure the offset there, correct, then measure once more
 * at the corrected instant. One pass is exact for a fixed-offset zone such as
 * Asia/Jakarta; the second is what keeps it right in a zone whose offset
 * changes, where the offset at the guess and the offset at the answer are not
 * the same number. Mirrors apps/web/lib/camera-time.ts, deliberately duplicated:
 * the two apps are separate installs wired only by a type-only import, and this
 * side needs the zone as an argument rather than as a module constant.
 */
export function localMidnightMs(day: string, timeZone = CAMERA_TZ): number {
  const guess = Date.parse(`${day}T00:00:00Z`)
  return guess - zoneOffsetMs(guess - zoneOffsetMs(guess, timeZone), timeZone)
}

/** The calendar day `delta` days away, stepped from local noon so a 23- or
 * 25-hour day cannot land the arithmetic on the wrong date. */
export const shiftDay = (day: string, delta: number, timeZone = CAMERA_TZ): string =>
  localDay(localMidnightMs(day, timeZone) + (12 + delta * 24) * 3_600_000, timeZone)

/** A camera-local calendar day as a half-open [start, end) window of epoch ms. */
export function dayWindow(day: string, timeZone = CAMERA_TZ): Span {
  return {
    start: localMidnightMs(day, timeZone),
    end: localMidnightMs(shiftDay(day, 1, timeZone), timeZone),
  }
}

/** Milliseconds from `now` until the next 00:15 camera-local. */
export function msUntilNextRun(now: number, timeZone = CAMERA_TZ): number {
  const today = localMidnightMs(localDay(now, timeZone), timeZone) + RUN_AT_MS
  if (today > now) return today - now

  const tomorrow = shiftDay(localDay(now, timeZone), 1, timeZone)
  return localMidnightMs(tomorrow, timeZone) + RUN_AT_MS - now
}

export type CoverageRow = {
  coverage: number
  gapCount: number
  longestGapSec: number
  bytesWritten: number
}

/**
 * Pure: timespans, segment sizes and a window in, one row out. No I/O and no
 * clock, which is what makes "running it twice produces the same row" testable.
 *
 * No clampToNow: a completed calendar day is entirely in the past, so the open
 * segment MediaMTX keeps reporting a growing duration for cannot reach this
 * window, and gaps() already clips at window.end.
 */
export function buildRow(raw: Span[], segments: Segment[], window: Span): CoverageRow {
  // The same sub-tolerance suppression routes/recordings.ts applies: a hole
  // shorter than a muxer boundary is not a hole. `coverage` stays exact and is
  // never re-derived from the gap list.
  const holes = gaps(raw, window).filter((g) => g.end - g.start > TOLERANCE_MS)

  return {
    coverage: coverage(raw, window),
    gapCount: holes.length,
    longestGapSec: Math.round(
      holes.reduce((longest, g) => Math.max(longest, g.end - g.start), 0) / 1000,
    ),
    bytesWritten: bytesIn(segments, window),
  }
}

/**
 * Which days this run should write.
 *
 * Bounded by evidence, never by the calendar: with no footage on disk there is
 * nothing to say, and writing `coverage: 0` for days before the system was
 * installed would put a fabricated outage into the one table meant to be the
 * honest record.
 *
 * The earliest day is deliberately skipped, and that is the load-bearing line.
 * recordDeleteAfter deletes oldest-first, so exactly one day - the boundary one
 * - is half-erased at any moment. Snapshotting it would overwrite the accurate
 * row written when that day was whole with a retention-truncated one, turning a
 * 99% day into a 50% day every night until it aged out. It is also the install
 * day on a fresh system, where a partial number describes when someone ran
 * `docker compose up`, not how well the recorder worked.
 */
export function daysToSnapshot(
  earliestMs: number | null,
  now: number,
  timeZone = CAMERA_TZ,
): string[] {
  if (earliestMs === null) return []

  const first = shiftDay(localDay(earliestMs, timeZone), 1, timeZone)
  const last = shiftDay(localDay(now, timeZone), -1, timeZone) // yesterday
  if (last < first) return []

  // Walked BACKWARDS from yesterday so the cap drops the oldest days rather
  // than the newest. Forwards, a long history would spend the whole budget on
  // days nobody is looking at and never reach last night. YYYY-MM-DD compares
  // lexicographically, which for this format is chronologically.
  const out: string[] = []
  let day = last
  while (day >= first && out.length < MAX_BACKFILL_DAYS) {
    out.push(day)
    day = shiftDay(day, -1, timeZone)
  }

  return out.reverse()
}

/**
 * Write one day. Upsert, never check-then-insert: `daily_coverage_slug_day_key`
 * is what makes this idempotent (docs/ARCHITECTURE.md#data), so re-running a day
 * overwrites rather than duplicating. The constraint enforces it; the
 * application never reads first, which is what keeps it correct under a
 * concurrent second run.
 */
export async function snapshotDay(slug: string, day: string, row: CoverageRow): Promise<void> {
  await db
    .insert(dailyCoverage)
    .values({ cameraSlug: slug, day, ...row })
    .onConflictDoUpdate({
      target: [dailyCoverage.cameraSlug, dailyCoverage.day],
      set: row,
    })
}

/**
 * One camera. MediaMTX and the filesystem are each read ONCE and the same two
 * answers are bucketed into every day - a per-day scan would walk the same
 * directory seven times for the same bytes.
 */
export async function snapshotCamera(slug: string, now: number): Promise<void> {
  let raw: Span[]
  try {
    raw = await listTimespans(slug)
  } catch (error) {
    // The playback API answers 400 both for a path it does not have and for one
    // that has simply never recorded, so 400 means "no footage" and no footage
    // means no days to write. Anything else is a failure to answer the
    // question, and a failure to ask must not be recorded as a bad night.
    if (!(error instanceof MediaMtxError) || error.status !== 400) throw error
    console.warn(`snapshot: no recordings for ${slug} -`, error.message)
    return
  }

  const earliest = raw.length === 0 ? null : Math.min(...raw.map((s) => s.start))
  const days = daysToSnapshot(earliest, now)
  if (days.length === 0) return

  const segments = await listSegments(slug)

  for (const day of days) {
    await snapshotDay(slug, day, buildRow(raw, segments, dayWindow(day)))
  }

  console.log(`snapshot: ${slug} wrote ${days.length} day(s) through ${days.at(-1)}`)
}

/**
 * Every enabled camera. Never rejects: this runs from a timer, and an unhandled
 * rejection there would take down a process whose other job is serving video.
 * Sequentially, each in its own try - one camera's failure must not abort
 * another's, and a fan-out would open concurrent connections against a pool
 * capped at max: 5.
 */
export async function runSnapshot(now: number): Promise<void> {
  let enabled: { slug: string }[]
  try {
    enabled = await db.select({ slug: cameras.slug }).from(cameras).where(eq(cameras.enabled, true))
  } catch (error) {
    console.error('snapshot: camera list failed -', error)
    return
  }

  for (const { slug } of enabled) {
    try {
      await snapshotCamera(slug, now)
    } catch (error) {
      console.error(`snapshot: ${slug} failed -`, error)
    }
  }
}

// A boolean rather than the timer handle, for the same reason the poller uses
// one: nothing ever stops this, the process is the lifecycle.
let started = false

function schedule(): void {
  // setTimeout re-armed each night rather than setInterval(24h): an interval
  // drifts, and a restart at 18:00 would fix its firing time at 18:00 forever.
  // This one always aims at the next 00:15 local, whenever it was armed.
  setTimeout(() => {
    void runSnapshot(Date.now()).finally(schedule)
  }, msUntilNextRun(Date.now()))
}

/**
 * Started from src/server.ts, never from src/index.ts - the entrypoint split is
 * what keeps a long-lived timer out of the module the test suite imports.
 *
 * Runs immediately, then nightly. The boot run is a backfill: it is idempotent
 * by construction, so it costs a handful of upserts and buys a trend that is
 * populated the moment the API starts and a day that is not lost forever
 * because the process happened to be down at midnight. 00:15 rather than 00:00
 * so the day's last segment has been closed and flushed.
 */
export function startSnapshot(): void {
  if (started) return
  started = true

  void runSnapshot(Date.now())
  schedule()
}
