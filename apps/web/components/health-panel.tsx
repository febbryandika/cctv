'use client'

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCoverage } from '@/components/timeline'
import { formatClock, formatShortDay, humanDuration } from '@/lib/camera-time'
import { api, type CameraHealth, type CoverageDay, type HealthResponse } from '@/lib/api'
import { cn } from '@/lib/utils'

// Disk free and bytes-per-hour move slowly, and the fast-moving fact - a camera
// dropping - arrives over SSE instead. This is the floor, not the mechanism.
const REFETCH_MS = 30_000

// The shipped recordDeleteAfter is 168h, so seven days of headroom is the scale
// at which "the disk fills before retention recycles it" starts to be true.
// It is a headroom warning and not a comparison against the real config: the
// API does not report retention, and parsing mediamtx.yml to find out would put
// a second reader of that file in a second process.
const LOW_HEADROOM_DAYS = 7

const gb = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`

export function HealthPanel() {
  const queryClient = useQueryClient()

  const { data, isPending, isError } = useQuery({
    queryKey: ['health'],
    queryFn: async ({ signal }) => {
      const res = await api.health.$get(undefined, { init: { signal } })
      // Thrown so an expired session surfaces as an error state rather than a
      // page of zeroes, which on this page would read as a dead system.
      if (!res.ok) throw new Error(`GET /health responded ${res.status}`)
      return res.json()
    },
    refetchInterval: REFETCH_MS,
  })

  useTransitionStream(() => {
    void queryClient.invalidateQueries({ queryKey: ['health'] })
  })

  if (isPending) return <Skeleton className="h-64 w-full rounded-xl" />

  if (isError) {
    return (
      <p className="text-muted-foreground text-sm">
        Could not reach the API. Retrying every {REFETCH_MS / 1000} seconds.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {data.mediamtx === 'down' ? (
        <p className="text-muted-foreground text-sm">
          MediaMTX is not responding, so live status and 24-hour coverage are unknown rather than
          zero. Disk figures are read from the filesystem and are still accurate.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {data.cameras.map((camera) => (
          <CameraCard key={camera.slug} camera={camera} />
        ))}
      </div>

      <DiskGauge disk={data.disk} />

      {data.cameras.map((camera) => (
        <CoverageTrend key={camera.slug} name={camera.name} history={camera.history} />
      ))}
    </div>
  )
}

/**
 * Transitions as they happen, so a drop is visible when it occurs rather than at
 * the next refetch (docs/ARCHITECTURE.md#observability).
 *
 * withCredentials is load-bearing and fails the same silent way `crossOrigin` on
 * the clip player does: the API is a separate origin, and EventSource sends no
 * cookie across one unless it is asked to - the route would answer 401 and the
 * page would simply never update, with nothing in any log.
 *
 * No reconnect logic: EventSource retries on its own, and the 30-second refetch
 * is the floor underneath it either way.
 */
function useTransitionStream(onTransition: () => void) {
  useEffect(() => {
    // Built through the typed client, so a rename of the route is a compile
    // error here instead of a stream that silently never opens.
    const source = new EventSource(api.health.events.$url().toString(), {
      withCredentials: true,
    })

    source.addEventListener('transition', (event) => {
      const { slug, kind, at } = JSON.parse((event as MessageEvent<string>).data) as {
        slug: string
        kind: 'up' | 'down'
        at: string
      }

      // The toast is the point. A number that quietly changed on a page nobody
      // was looking at is what this endpoint exists to improve on.
      toast(kind === 'down' ? `${slug} went down` : `${slug} is back`, {
        description: formatClock(at),
      })

      onTransition()
    })

    return () => source.close()
    // onTransition is a fresh closure each render and re-subscribing on every
    // one would tear the stream down 30 seconds at a time. The callback only
    // ever invalidates a query key, so the first one stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

function CameraCard({ camera }: { camera: CameraHealth }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{camera.name}</CardTitle>
        <CardDescription>{camera.slug}</CardDescription>
        <CardAction>
          {/* No `success` variant in the radix-nova registry, and editing
              badge.tsx would drift it from the registry — a dot carries the
              state instead. */}
          <Badge variant={camera.online ? 'outline' : 'destructive'}>
            <span
              aria-hidden
              className={cn(
                'size-1.5 rounded-full',
                camera.online ? 'bg-emerald-500' : 'bg-destructive',
              )}
            />
            {camera.online ? 'Online' : 'Offline'}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Figure
          value={
            camera.coverage24h === null
              ? '—'
              : formatCoverage(camera.coverage24h, (camera.gapCount ?? 0) > 0)
          }
          caption={camera.coverage24h === null ? 'coverage unknown' : 'covered, last 24h'}
        />
        <Figure
          value={camera.gapCount === null ? '—' : String(camera.gapCount)}
          caption={
            camera.longestGapSec
              ? `gaps, longest ${humanDuration(camera.longestGapSec)}`
              : 'gaps, last 24h'
          }
        />
        <Figure value={gb(camera.bytesWritten24h)} caption="written, last 24h" />
      </CardContent>
    </Card>
  )
}

function DiskGauge({ disk }: { disk: HealthResponse['disk'] }) {
  const { freeBytes, totalBytes, bytesPerHour, daysRemaining } = disk

  const usedFraction =
    freeBytes !== null && totalBytes !== null && totalBytes > 0
      ? (totalBytes - freeBytes) / totalBytes
      : 0

  const low = daysRemaining !== null && daysRemaining < LOW_HEADROOM_DAYS

  return (
    <Card>
      <CardHeader>
        <CardTitle>Disk</CardTitle>
        <CardDescription>
          Days remaining is projected from bytes actually written, not from the configured retention
          — a retention setting nobody checked against a real bitrate is a guess.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Aria-hidden and not focusable: a bar of pixels is not a control. The
            figures below are the equivalent path, the same way the timeline's
            span list is. */}
        <div
          aria-hidden="true"
          data-testid="disk-gauge"
          className="bg-muted relative h-3 w-full overflow-hidden rounded-full"
        >
          <div
            className={cn('absolute inset-y-0 left-0', low ? 'bg-destructive' : 'bg-emerald-500')}
            style={{ width: `${(usedFraction * 100).toFixed(2)}%` }}
          />
        </div>

        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <Figure
            value={freeBytes === null ? '—' : gb(freeBytes)}
            // The denominator, because the bar above is USED space and a
            // near-full bar beside a bare "57.3 GB" is ambiguous on its own.
            caption={totalBytes === null ? 'free' : `free of ${gb(totalBytes)}`}
          />
          <Figure value={`${(bytesPerHour / 1_000_000_000).toFixed(2)} GB`} caption="per hour" />
          <Figure
            value={daysRemaining === null ? '—' : daysRemaining.toFixed(1)}
            caption="days until full"
            warn={low}
          />
        </div>

        {daysRemaining === null && bytesPerHour === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing has been written in the last 24 hours, so there is no rate to project from.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function CoverageTrend({ name, history }: { name: string; history: CoverageDay[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Coverage history — {name}</CardTitle>
        <CardDescription>
          Written nightly and kept after the footage is deleted. The two things worth watching are
          coverage trending down and bytes per day trending up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {history.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No snapshots yet. The first row is written after midnight, camera-local.
          </p>
        ) : (
          <>
            {/* Each column IS the shortfall colour, with the covered fraction
                painted up from the bottom — the same inversion the timeline
                track uses, so a bad day cannot round away to nothing. */}
            <div
              aria-hidden="true"
              data-testid="coverage-trend"
              className="flex h-24 items-end gap-1"
            >
              {history.map((day) => (
                <div
                  key={day.day}
                  // Capped, so a history two days long reads as two bars rather
                  // than as two slabs filling the card.
                  className="bg-destructive/85 relative h-full max-w-16 flex-1 overflow-hidden rounded-sm"
                >
                  <div
                    className="absolute inset-x-0 bottom-0 bg-emerald-500"
                    style={{ height: `${(day.coverage * 100).toFixed(2)}%` }}
                  />
                </div>
              ))}
            </div>

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
                      {day.bytesWritten === null ? '—' : gb(day.bytesWritten)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Figure({ value, caption, warn }: { value: string; caption: string; warn?: boolean }) {
  return (
    <div>
      <p
        className={cn(
          'text-2xl leading-none font-semibold tabular-nums',
          warn && 'text-amber-600 dark:text-amber-500',
        )}
      >
        {value}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">{caption}</p>
    </div>
  )
}
