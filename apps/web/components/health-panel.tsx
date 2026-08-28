'use client'

import { HardDriveIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Figure, StatCard } from '@/components/stat'
import { StatusPill } from '@/components/status-pill'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatClock, formatShortDay, humanDuration } from '@/lib/camera-time'
import { formatCoverage, formatGb, LOW_HEADROOM_DAYS } from '@/lib/format'
import { HEALTH_REFETCH_MS, useCameras, useHealth } from '@/lib/queries'
import { useNow } from '@/lib/use-now'
import type { CameraHealth, CoverageDay, HealthResponse } from '@/lib/api'
import { cn } from '@/lib/utils'

// recordDeleteAfter in mediamtx.template.yml. Displayed, never enforced here —
// MediaMTX owns retention (docs/ARCHITECTURE.md#the-media-pipeline) and this is
// a second reader of that file, so it drifts if the template changes.
const RETENTION_HOURS = 168

const UPTIME_TICK_MS = 30_000

export function HealthPanel() {
  const { data, isPending, isError } = useHealth()
  const cameras = useCameras()
  const now = useNow(UPTIME_TICK_MS)

  if (isPending) {
    return (
      <div className="space-y-4 px-7 pt-5 pb-8">
        <Skeleton className="h-[104px] w-full rounded-lg" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="px-7 pt-5 pb-8">
        <p className="text-muted-foreground text-sm">
          Could not reach the API. Retrying every {HEALTH_REFETCH_MS / 1000} seconds.
        </p>
      </div>
    )
  }

  const readyAt = cameras.data?.cameras.find((entry) => entry.readyAt !== null)?.readyAt ?? null

  return (
    <div className="flex max-w-[1560px] flex-col gap-4 px-7 pt-5 pb-8">
      {data.mediamtx === 'down' ? (
        <p className="text-muted-foreground text-sm">
          MediaMTX is not responding, so live status and 24-hour coverage are unknown rather than
          zero. Disk figures are read from the filesystem and are still accurate.
        </p>
      ) : null}

      {data.cameras.map((camera) => (
        <CameraRow key={camera.slug} camera={camera} readyAt={readyAt} now={now} />
      ))}

      <DiskCard disk={data.disk} checkedAt={data.checkedAt} />

      {data.cameras.map((camera) => (
        <CoverageTrend key={camera.slug} name={camera.name} history={camera.history} />
      ))}
    </div>
  )
}

function CameraRow({
  camera,
  readyAt,
  now,
}: {
  camera: CameraHealth
  readyAt: number | null
  now: number | null
}) {
  const uptime =
    readyAt !== null && now !== null
      ? humanDuration(Math.max(0, Math.round((now - readyAt) / 1000)))
      : null

  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
      <div className="bg-card rounded-lg border px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-[11px] font-semibold tracking-[0.07em] uppercase">
            Camera
          </span>
          <StatusPill online={camera.online} />
        </div>
        <div className="mt-1.5 text-[22px] leading-none font-semibold">{camera.name}</div>
        <div className="text-muted-foreground mt-1.5 font-mono text-[11.5px]">
          {camera.slug}
          {uptime ? ` · up ${uptime}` : camera.enabled ? '' : ' · disabled'}
        </div>
      </div>

      <StatCard
        label="Coverage, last 24h"
        value={
          camera.coverage24h === null
            ? '—'
            : formatCoverage(camera.coverage24h, (camera.gapCount ?? 0) > 0)
        }
        caption={
          camera.coverage24h === null
            ? 'MediaMTX could not be asked, so this is unknown — not zero'
            : 'a rolling window, so it spans two calendar days'
        }
      />

      <StatCard
        label="Longest gap, 24h"
        value={camera.longestGapSec ? humanDuration(camera.longestGapSec) : '—'}
        caption={
          camera.gapCount === null
            ? 'unknown'
            : camera.gapCount === 0
              ? 'no gaps longer than 2 seconds'
              : `across ${camera.gapCount} gap${camera.gapCount === 1 ? '' : 's'} over 2s`
        }
      />

      <StatCard
        label="Written, last 24h"
        value={formatGb(camera.bytesWritten24h)}
        caption={`${formatGb(camera.bytesWritten24h / 24)} per hour, measured off disk`}
      />
    </div>
  )
}

function DiskCard({ disk, checkedAt }: { disk: HealthResponse['disk']; checkedAt: string }) {
  const { freeBytes, totalBytes, bytesPerHour, daysRemaining } = disk

  const usedFraction =
    freeBytes !== null && totalBytes !== null && totalBytes > 0
      ? (totalBytes - freeBytes) / totalBytes
      : 0

  const low = daysRemaining !== null && daysRemaining < LOW_HEADROOM_DAYS

  return (
    <section className="bg-card rounded-xl border p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold">
            <HardDriveIcon className="text-muted-foreground size-4" aria-hidden />
            Disk
          </h2>
          <p className="text-muted-foreground mt-1.5 max-w-[80ch] text-[13px] leading-relaxed">
            Days remaining is projected from bytes actually written, not from the configured
            retention — a retention setting nobody checked against a real bitrate is a guess.
          </p>
        </div>
        {low ? (
          <span className="bg-destructive text-destructive-foreground inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold">
            Low headroom
          </span>
        ) : null}
      </div>

      <div className="mt-4 flex items-center gap-3">
        {/* Aria-hidden and not focusable: a bar of pixels is not a control. The
            figures below are the equivalent path, the same way the timeline's
            span list is. */}
        <div
          aria-hidden="true"
          data-testid="disk-gauge"
          className="bg-muted relative h-3 w-full overflow-hidden rounded-full"
        >
          <div
            className={cn('absolute inset-y-0 left-0', low ? 'bg-destructive' : 'bg-rec')}
            style={{ width: `${(usedFraction * 100).toFixed(2)}%` }}
          />
        </div>
        <span className="text-muted-foreground shrink-0 text-[11.5px] tabular-nums">
          {(usedFraction * 100).toFixed(0)}% used
        </span>
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-x-10 gap-y-4">
        <Figure
          value={freeBytes === null ? '—' : formatGb(freeBytes)}
          // The denominator, because the bar above is USED space and a
          // near-full bar beside a bare "57.3 GB" is ambiguous on its own.
          caption={totalBytes === null ? 'free' : `free of ${formatGb(totalBytes)}`}
        />
        <Figure
          value={`${(bytesPerHour / 1_000_000_000).toFixed(2)} GB`}
          caption="written per hour"
        />
        <Figure
          value={daysRemaining === null ? '—' : daysRemaining.toFixed(1)}
          caption="days until full"
          warn={low}
        />
        <Figure
          value={`${RETENTION_HOURS} h`}
          caption={`retention · recycles at ${RETENTION_HOURS / 24} days`}
        />
      </div>

      {daysRemaining === null && bytesPerHour === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">
          Nothing has been written in the last 24 hours, so there is no rate to project from.
        </p>
      ) : null}

      <p className="text-muted-foreground mt-4 text-[11.5px]">
        Last checked {formatClock(checkedAt)}.
      </p>
    </section>
  )
}

function CoverageTrend({ name, history }: { name: string; history: CoverageDay[] }) {
  const router = useRouter()

  return (
    <section className="bg-card rounded-xl border p-5">
      <h2 className="text-[13px] font-semibold">Coverage history — {name}</h2>
      <p className="text-muted-foreground mt-1.5 max-w-[80ch] text-[13px] leading-relaxed">
        Written nightly and kept after the footage is deleted. The two things worth watching are
        coverage trending down and bytes per day trending up.
      </p>

      {history.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">
          No snapshots yet. The first row is written after midnight, camera-local.
        </p>
      ) : (
        <>
          {/* Each column IS the shortfall colour, with the covered fraction
              painted up from the bottom — the same inversion the timeline
              track uses, so a bad day cannot round away to nothing. */}
          {/* Oldest on the left, so the trend reads left-to-right — which is
              the opposite order to the table below, where the newest row is the
              one you want first. Both are right for their own shape, so each
              carries its own day label rather than leaving the reader to infer
              a direction. */}
          <div data-testid="coverage-trend" className="mt-5 flex items-end gap-1.5">
            {history.map((day) => (
              <button
                key={day.day}
                type="button"
                // The snapshot outlives the footage, so a day here may no
                // longer be playable — /recordings says so when it isn't.
                onClick={() => router.push(`/recordings?day=${day.day}`)}
                aria-label={`${formatShortDay(day.day)}: ${formatCoverage(day.coverage, day.gapCount > 0)} covered`}
                // Capped, so a history two days long reads as two bars rather
                // than as two slabs filling the card.
                className="group max-w-16 flex-1"
              >
                <span className="block text-[11px] font-medium tabular-nums">
                  {(day.coverage * 100).toFixed(0)}%
                </span>
                <span className="bg-destructive group-focus-visible:ring-ring relative mt-1 block h-24 overflow-hidden rounded-sm group-focus-visible:ring-2">
                  <span
                    aria-hidden
                    className="bg-rec absolute inset-x-0 bottom-0 block"
                    style={{ height: `${(day.coverage * 100).toFixed(2)}%` }}
                  />
                </span>
                <span className="text-muted-foreground mt-1.5 block text-[11px] whitespace-nowrap">
                  {formatShortDay(day.day)}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-5 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Coverage</TableHead>
                  <TableHead className="text-right">Gaps</TableHead>
                  <TableHead className="text-right">Longest</TableHead>
                  <TableHead className="text-right">Written</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...history].reverse().map((day) => (
                  <TableRow key={day.day}>
                    <TableCell>{formatShortDay(day.day)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCoverage(day.coverage, day.gapCount > 0)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{day.gapCount}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {day.longestGapSec ? humanDuration(day.longestGapSec) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {day.bytesWritten === null ? '—' : formatGb(day.bytesWritten)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </section>
  )
}
