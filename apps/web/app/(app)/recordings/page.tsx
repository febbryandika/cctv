import { connection } from 'next/server'
import { Timeline } from '@/components/timeline'
import { CAMERA_TZ, todayLocalDay } from '@/lib/camera-time'

export default async function RecordingsPage() {
  // Opts out of static prerendering, which matters more than it looks. Without
  // it Next renders this page at build time and bakes the build date in as
  // "today" forever; computing it inside the client component instead makes
  // server and client disagree, a whole-day disagreement across midnight.
  // Resolved once here and passed down, so both renders read the same string.
  await connection()

  const today = todayLocalDay()

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Recordings</h1>
        <p className="text-muted-foreground text-sm">
          What was actually recorded, in {CAMERA_TZ.replace('_', ' ')} time. Gaps are shown as gaps
          — never smoothed over — with the cause inferred from the stream log where there is one.
        </p>
      </div>
      <Timeline slug="yard" today={today} />
    </section>
  )
}
