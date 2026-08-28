'use client'

import { useState } from 'react'
import { LivePlayer } from '@/components/live-player'
import { StatCard } from '@/components/stat'
import { Skeleton } from '@/components/ui/skeleton'
import { humanDuration } from '@/lib/camera-time'
import { formatCoverage } from '@/lib/format'
import { CAMERAS_REFETCH_MS, useCameras, useHealth } from '@/lib/queries'
import { useNow } from '@/lib/use-now'

// Uptime is measured in hours; a slower tick is plenty and keeps a page that
// may be left open all night from re-rendering once a second for nothing.
const UPTIME_TICK_MS = 30_000

export function CameraList() {
  const { data, isPending, isError } = useCameras()
  const health = useHealth()
  const now = useNow(UPTIME_TICK_MS)

  // Reported by the player itself rather than by a script: this is the number
  // for THIS session on THIS machine. `measure` reports a median of five from a
  // headless browser (docs/ARCHITECTURE.md#measurement) and the two are not
  // interchangeable, so the caption says which one this is.
  const [ttffMs, setTtffMs] = useState<number | null>(null)

  if (isPending) {
    return (
      <div className="flex flex-1 flex-col gap-3.5 px-7 pt-5 pb-6">
        <Skeleton className="min-h-[300px] flex-1 rounded-xl" />
        <Skeleton className="h-[86px] shrink-0 rounded-lg" />
      </div>
    )
  }

  // The API being unreachable is a different fact from a camera being down, and
  // the page says which. The banner in the header carries the retry; this is
  // just the hole where the picture would be.
  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center px-7 py-6">
        <p className="text-muted-foreground text-sm">
          Could not reach the API. Retrying every {CAMERAS_REFETCH_MS / 1000} seconds.
        </p>
      </div>
    )
  }

  const camera = data.cameras[0]
  const reading = health.data?.cameras.find((entry) => entry.slug === camera?.slug)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 px-7 pt-5 pb-6">
      {data.mediamtx === 'down' ? (
        <p className="text-muted-foreground shrink-0 text-sm">
          MediaMTX is not responding, so every camera reads as offline — a camera that cannot be
          confirmed up is not up.
        </p>
      ) : null}

      {data.cameras.map((entry) => (
        // Mounted whatever the status poll says. The player reports the
        // connection it actually has, which is a fresher and more honest fact
        // than a poll that can be up to ten seconds stale. The bare slug goes
        // in: the API resolves it to the sub-stream
        // (docs/ARCHITECTURE.md#the-media-pipeline).
        <LivePlayer
          key={entry.slug}
          slug={entry.slug}
          name={entry.name}
          onTimeToFirstFrame={setTtffMs}
        />
      ))}

      <div className="grid shrink-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(186px,1fr))]">
        <StatCard
          label="Uptime"
          value={
            camera?.readyAt != null && now !== null
              ? humanDuration(Math.max(0, Math.round((now - camera.readyAt) / 1000)))
              : '—'
          }
          caption={
            camera?.readyAt != null ? 'since the last transition' : 'camera is not publishing'
          }
        />
        <StatCard
          label="Time to first frame"
          value={
            ttffMs === null ? (
              '—'
            ) : (
              <>
                {ttffMs} <span className="text-muted-foreground text-[13px] font-medium">ms</span>
              </>
            )
          }
          caption="this session · WHEP post to first decoded frame"
        />
        <StatCard
          label="Coverage 24h"
          value={
            reading && reading.coverage24h !== null
              ? formatCoverage(reading.coverage24h, (reading.gapCount ?? 0) > 0)
              : '—'
          }
          caption={
            reading?.gapCount == null
              ? 'coverage unknown'
              : reading.gapCount === 0
                ? 'no gaps over 2s'
                : `${reading.gapCount} gap${reading.gapCount === 1 ? '' : 's'} over 2s`
          }
        />
      </div>
    </div>
  )
}
