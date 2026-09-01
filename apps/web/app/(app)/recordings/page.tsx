import { connection } from 'next/server'
import { RecordingsBrowser } from '@/components/recordings-browser'
import { localDay, todayLocalDay } from '@/lib/camera-time'

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// Shape only. This page has no database and must not fetch the camera list to
// find out whether a slug exists - the picker does that, and falls back to the
// first camera when the slug is not in the fleet. Same discipline as
// DAY_PATTERN above: reject what cannot be a slug, let the client reject what
// merely is not one of ours.
const SLUG_PATTERN = /^[a-z][a-z0-9]*$/

const one = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined

export default async function RecordingsPage({ searchParams }: PageProps<'/recordings'>) {
  // Opts out of static prerendering, which matters more than it looks. Without
  // it Next renders this page at build time and bakes the build date in as
  // "today" forever; computing it inside the client component instead makes
  // server and client disagree, a whole-day disagreement across midnight.
  // Resolved once here and passed down, so both renders read the same string.
  await connection()

  const today = todayLocalDay()
  const params = await searchParams

  // ?at=<RFC3339> is the live view's "last 5 minutes" jump, and the health
  // page's history bars link with ?day=. Both are validated here rather than in
  // the client component: a hand-typed day in the future makes the API answer
  // 400 window_in_future, and a NaN would make the query key unstable.
  const at = one(params.at)
  const atMs = at ? Date.parse(at) : NaN
  const jumpTo = Number.isFinite(atMs) ? atMs : undefined

  const requested = jumpTo !== undefined ? localDay(jumpTo) : one(params.day)
  const day = requested && DAY_PATTERN.test(requested) && requested <= today ? requested : undefined

  const asked = one(params.camera)
  const camera = asked && SLUG_PATTERN.test(asked) ? asked : undefined

  return (
    <RecordingsBrowser initialSlug={camera} today={today} initialDay={day} initialAtMs={jumpTo} />
  )
}
