'use client'

import { useEffect, useState } from 'react'
import { LivePlayer } from '@/components/live-player'
import { StatCard } from '@/components/stat'
import { Skeleton } from '@/components/ui/skeleton'
import { humanDuration } from '@/lib/camera-time'
import { formatCoverage } from '@/lib/format'
import { CAMERAS_REFETCH_MS, useCameras, useHealth } from '@/lib/queries'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

// Uptime is measured in hours; a slower tick is plenty and keeps a page that
// may be left open all night from re-rendering once a second for nothing.
const UPTIME_TICK_MS = 30_000

export function CameraList() {
  const { data, isPending, isError } = useCameras()
  const health = useHealth()
  const now = useNow(UPTIME_TICK_MS)

  // Which tile fills the view, or null for the grid. Client state rather than a
  // URL parameter on purpose: the players stay mounted either way, so focusing
  // is a layout change and nothing else. Routing it would mean a server
  // round-trip that can remount the tree, and remounting a LivePlayer tears
  // down its WHEP session — seven re-handshakes to zoom in on one camera.
  const [focused, setFocused] = useState<string | null>(null)

  // Reported by the player itself rather than by a script: this is the number
  // for THIS session on THIS machine. `measure` reports a median of five from a
  // headless browser (docs/ARCHITECTURE.md#measurement) and the two are not
  // interchangeable, so the caption says which one this is.
  //
  // Keyed by slug because every tile reports its own. One shared value would
  // show whichever camera happened to connect last.
  const [ttffMs, setTtffMs] = useState<Record<string, number>>({})

  // Escape leaves focus, but not while the browser is in its own fullscreen —
  // there Escape belongs to the browser, and taking it would drop the operator
  // two levels out from one keypress.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.fullscreenElement) return
      setFocused(null)
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

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

  // A single camera is always its own focus, so a one-camera install behaves
  // exactly as it did before there was a grid — full-size chrome, and `f` still
  // toggles fullscreen. A slug that has dropped out of the fleet falls back to
  // the grid rather than blanking the page.
  const active =
    data.cameras.length === 1
      ? (data.cameras[0]?.slug ?? null)
      : focused !== null && data.cameras.some((entry) => entry.slug === focused)
        ? focused
        : null

  const camera = data.cameras.find((entry) => entry.slug === active) ?? data.cameras[0]
  const reading = health.data?.cameras.find((entry) => entry.slug === camera?.slug)

  // Fleet figures are the WORST case, never a mean. An average coverage across
  // seven cameras hides one dead camera behind six healthy ones, which is the
  // specific lie this project exists to prevent.
  const readings = health.data?.cameras ?? []
  const measured = readings.filter((entry) => entry.coverage24h !== null)
  const worst = measured.reduce<(typeof measured)[number] | undefined>(
    (lowest, entry) =>
      lowest === undefined || (entry.coverage24h ?? 1) < (lowest.coverage24h ?? 1) ? entry : lowest,
    undefined,
  )
  const online = data.cameras.filter((entry) => entry.online).length
  const reported = Object.values(ttffMs)
  const slowest = reported.length > 0 ? Math.max(...reported) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 px-7 pt-5 pb-6">
      {data.mediamtx === 'down' ? (
        <p className="text-muted-foreground shrink-0 text-sm">
          MediaMTX is not responding, so every camera reads as offline — a camera that cannot be
          confirmed up is not up.
        </p>
      ) : null}

      {/* Focusing hides the other tiles rather than unmounting them, so their
          WHEP sessions survive and coming back to the grid is instant instead of
          seven fresh handshakes. */}
      <div
        className={cn(
          'grid min-h-0 flex-1 gap-2.5',
          active === null &&
            'grid-cols-1 [grid-auto-rows:minmax(0,1fr)] sm:grid-cols-2 xl:grid-cols-3',
        )}
      >
        {data.cameras.map((entry) => (
          // Mounted whatever the status poll says. The player reports the
          // connection it actually has, which is a fresher and more honest fact
          // than a poll that can be up to ten seconds stale. The bare slug goes
          // in: the API resolves it to the sub-stream
          // (docs/ARCHITECTURE.md#the-media-pipeline).
          <div
            key={entry.slug}
            // Either/or rather than `flex` plus a conditional `hidden`: both are
            // display utilities, so which one wins would depend on their order in
            // the stylesheet rather than on anything written here.
            className={active !== null && active !== entry.slug ? 'hidden' : 'flex min-h-0'}
          >
            <LivePlayer
              slug={entry.slug}
              name={entry.name}
              focused={active === entry.slug}
              onToggleFocus={
                data.cameras.length === 1
                  ? undefined
                  : () => setFocused((was) => (was === entry.slug ? null : entry.slug))
              }
              onTimeToFirstFrame={(ms) => setTtffMs((prev) => ({ ...prev, [entry.slug]: ms }))}
            />
          </div>
        ))}
      </div>

      {/* Focused, the cards describe that camera. In the grid they describe the
          fleet, and every fleet number is a worst case. */}
      <div className="grid shrink-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(186px,1fr))]">
        {active === null ? (
          <StatCard
            label="Cameras online"
            value={`${online}/${data.cameras.length}`}
            caption={online === data.cameras.length ? 'all publishing' : 'ready in MediaMTX now'}
          />
        ) : (
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
        )}
        <StatCard
          label="Time to first frame"
          value={(() => {
            const value = active === null ? slowest : (ttffMs[active] ?? null)
            return value === null ? (
              '—'
            ) : (
              <>
                {value} <span className="text-muted-foreground text-[13px] font-medium">ms</span>
              </>
            )
          })()}
          caption={
            active === null
              ? `slowest of ${reported.length} · this session`
              : 'this session · WHEP post to first decoded frame'
          }
        />
        <StatCard
          label="Coverage 24h"
          value={(() => {
            const entry = active === null ? worst : reading
            return entry && entry.coverage24h !== null
              ? formatCoverage(entry.coverage24h, (entry.gapCount ?? 0) > 0)
              : '—'
          })()}
          caption={(() => {
            const entry = active === null ? worst : reading
            if (entry?.gapCount == null) return 'coverage unknown'
            const gaps = `${entry.gapCount} gap${entry.gapCount === 1 ? '' : 's'} over 2s`
            if (active !== null) return entry.gapCount === 0 ? 'no gaps over 2s' : gaps
            return `lowest of ${measured.length} · ${entry.name}`
          })()}
        />
      </div>
    </div>
  )
}
