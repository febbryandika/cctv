// The render boundary, and the only place in the web app that turns an instant
// into a wall-clock string (docs/ARCHITECTURE.md#timeline-gaps-and-coverage).
//
// The API speaks epoch-ms internally and answers in RFC3339 UTC; the operator
// thinks in the camera's local time. Everything that bridges those two lives
// here, so there is exactly one file to audit when a timeline looks seven hours
// wrong. Shared by the server page and the client component, so no 'use client'.

// A full static member expression, because that is the only form Next inlines
// at build time. The literal default is what actually applies in practice: Next
// reads apps/web/.env*, not the repo-root .env where TZ lives, and CI builds
// with no environment at all.
const CONFIGURED_TZ = process.env.NEXT_PUBLIC_CAMERA_TZ ?? 'Asia/Jakarta'

// Validated once, here, rather than at every call site. An unknown IANA name
// makes Intl throw RangeError, and a client component whose module scope throws
// renders nothing at all - a blank page instead of a timezone complaint.
function resolveZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone })
    return zone
  } catch {
    console.error(`camera-time: unknown time zone ${zone}, falling back to UTC`)
    return 'UTC'
  }
}

export const CAMERA_TZ = resolveZone(CONFIGURED_TZ)

const HOUR_MS = 3_600_000

// en-CA renders YYYY-MM-DD, which is both what <input type="date"> takes and
// what sorts correctly as a string. toISOString().slice(0, 10) would be the UTC
// day, which in WIB calls the first seven hours of every day "yesterday" - and
// would make today unselectable in the picker before 07:00.
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: CAMERA_TZ })

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: CAMERA_TZ,
  hour: '2-digit',
  minute: '2-digit',
})

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: CAMERA_TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAMERA_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** The camera zone's offset from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(at: number): number {
  const parts = partsFormat.formatToParts(new Date(at))
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
export const localDay = (at: number): string => dayFormat.format(new Date(at))

/**
 * The instant at which a camera-local calendar day begins.
 *
 * Guess UTC midnight, measure the zone's offset there, correct, then measure
 * once more at the corrected instant. One pass is exact for a fixed-offset zone
 * such as Asia/Jakarta, which has no DST; the second is what keeps it right in
 * a zone whose offset changes, where the offset at the guess and the offset at
 * the answer are not the same number.
 */
export function localMidnightMs(day: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`)
  return guess - zoneOffsetMs(guess - zoneOffsetMs(guess))
}

/**
 * The calendar day `delta` days from `day`, in camera-local terms. Stepped from
 * local noon so a 23- or 25-hour day cannot land the arithmetic on the wrong
 * date.
 */
export const shiftDay = (day: string, delta: number): string =>
  localDay(localMidnightMs(day) + 12 * HOUR_MS + delta * 24 * HOUR_MS)

/** An RFC3339 instant as camera-local HH:MM. */
export const formatClock = (iso: string): string => clockFormat.format(new Date(iso))

/**
 * The camera-local calendar day happening now.
 *
 * The clock is read here rather than in a component body: it is the one impure
 * call this feature needs, and React's purity rule rightly refuses it during
 * render. The page resolves it once on the server and passes the string down,
 * so the client never reads a clock at all.
 */
export const todayLocalDay = (): string => localDay(Date.now())

/** A camera-local calendar day, spelled out for a human. */
export const formatDay = (day: string): string => dateFormat.format(new Date(localMidnightMs(day)))

// Short enough to sit under a bar in a two-week strip, where the year is
// implied and the weekday is noise.
const shortDayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: CAMERA_TZ,
  day: 'numeric',
  month: 'short',
})

/** A camera-local calendar day as `21 Aug`, for a chart axis. */
export const formatShortDay = (day: string): string =>
  shortDayFormat.format(new Date(localMidnightMs(day)))

/** Seconds as the shortest unambiguous human phrase: 45s, 22m 50s, 4h 28m. */
export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
  }

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}
