'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { api, type TimelineGap } from '@/lib/api'
import { formatClock, formatDay, humanDuration, localMidnightMs, shiftDay } from '@/lib/camera-time'
import { cn } from '@/lib/utils'

// docs/ARCHITECTURE.md#timeline-gaps-and-coverage: a gap must never render as
// continuous recording. Everything below follows from that one sentence — the
// gap-coloured track, the third state for hours that have not happened, the
// refusal to print 100%, and the list that says the same thing without needing
// a mouse.

const CAUSE_LABEL: Record<TimelineGap['cause'], string> = {
  camera_down: 'camera down',
  unknown: 'unknown',
}

// Four ticks plus the closing one: 00:00, 06:00, 12:00, 18:00, 24:00 in a
// 24-hour zone. Positioned by fraction of the window rather than by adding
// hours, so a 23- or 25-hour day still labels its own quarters.
const TICKS = [0, 1, 2, 3, 4]

export function Timeline({ slug, today }: { slug: string; today: string }) {
  const [day, setDay] = useState(today)

  // Pure functions of the selected day, and deliberately not of Date.now():
  // a clock reading here would change the query key on every render and
  // refetch forever. What has actually elapsed is the server's answer, below.
  const dayStart = localMidnightMs(day)
  const dayEnd = localMidnightMs(shiftDay(day, 1))
  const dayLength = dayEnd - dayStart

  const { data, isPending, isError } = useQuery({
    queryKey: ['timeline', slug, day],
    queryFn: async ({ signal }) => {
      const res = await api.recordings[':slug'].timeline.$get(
        {
          param: { slug },
          // The whole local day, every time. The server clamps the end to its
          // own `now` and reports what it used, so "has this hour happened?" is
          // never decided by a browser clock that may be minutes off.
          query: { from: new Date(dayStart).toISOString(), to: new Date(dayEnd).toISOString() },
        },
        { init: { signal } },
      )

      // Thrown so an expired session surfaces as an error state rather than a
      // blank bar that looks like a day with no recordings.
      if (!res.ok) throw new Error(`GET /recordings/${slug}/timeline responded ${res.status}`)
      return res.json()
    },
    // The provider defaults to staleTime 5s and retry 1. Neither suits this:
    // an operator refreshing to see whether a gap closed must not be handed the
    // answer from before it closed, and a 400 is not worth asking twice.
    staleTime: 0,
    retry: false,
  })

  const atToday = day >= today

  const picker = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setDay(shiftDay(day, -1))}>
          Previous
        </Button>
        <input
          type="date"
          value={day}
          max={today}
          // max only constrains the picker UI; a typed value can still exceed
          // it, and the API would answer 400 window_in_future.
          onChange={(event) => {
            const next = event.target.value
            if (next && next <= today) setDay(next)
          }}
          aria-label="Day to show"
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={atToday}
          onClick={() => setDay(shiftDay(day, 1))}
        >
          Next
        </Button>
      </div>
      {/* The control renders in the BROWSER's locale; this is the camera's. */}
      <p className="text-muted-foreground text-sm">{formatDay(day)}</p>
    </div>
  )

  if (isPending) {
    return (
      <section className="space-y-4">
        {picker}
        <Skeleton className="h-12 w-full rounded-md" />
      </section>
    )
  }

  if (isError) {
    return (
      <section className="space-y-4">
        {picker}
        <p className="text-muted-foreground text-sm">
          Could not load the timeline for this day. The API may be unreachable, or the session may
          have expired.
        </p>
      </section>
    )
  }

  const windowEnd = Date.parse(data.window.to)
  const notYetMs = Math.max(0, dayEnd - windowEnd)
  const truncated = notYetMs > 0

  const left = (iso: string) => ((Date.parse(iso) - dayStart) / dayLength) * 100
  const width = (from: string, to: string) =>
    ((Date.parse(to) - Date.parse(from)) / dayLength) * 100

  const describe = (gap: TimelineGap) =>
    `Gap, ${humanDuration(gap.durationSec)}, from ${formatClock(gap.start)} to ${formatClock(gap.end)}, cause: ${CAUSE_LABEL[gap.cause]}`

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        {picker}
        <div className="text-right">
          <p className="text-2xl leading-none font-semibold tabular-nums">
            {formatCoverage(data.coverage, data.gaps.length > 0)}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            {truncated ? 'covered, of the day so far' : 'covered'}
          </p>
        </div>
      </div>

      <TooltipProvider>
        <div className="relative">
          {/* The track IS the gap colour and spans are painted on top, rather
              than drawing a gap element per hole. A gap too narrow to occupy a
              pixel then still shows as a hairline of background instead of
              vanishing — which is the one failure mode this bar may not have. */}
          <div
            className="bg-destructive/85 relative h-12 w-full overflow-hidden rounded-md"
            aria-hidden="true"
          >
            {data.spans.map((span) => (
              <div
                key={span.start}
                className="absolute inset-y-0 bg-emerald-500"
                style={{ left: `${left(span.start)}%`, width: `${width(span.start, span.end)}%` }}
              />
            ))}
            {truncated && (
              <div
                className="bg-muted absolute inset-y-0 right-0"
                style={{ left: `${left(data.window.to)}%` }}
              />
            )}
          </div>

          {/* Hit targets, sized independently of the picture. The visual gap
              keeps its true width; this is a 12px-minimum target centred on it,
              so a 20-second hole stays reachable without being drawn as
              minutes. Focusable, so the tooltip opens from the keyboard. */}
          {data.gaps.map((gap) => (
            <Tooltip key={gap.start}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={describe(gap)}
                  className="focus-visible:ring-ring absolute inset-y-0 min-w-3 -translate-x-1/2 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
                  style={{
                    left: `${left(gap.start) + width(gap.start, gap.end) / 2}%`,
                    width: `${width(gap.start, gap.end)}%`,
                  }}
                />
              </TooltipTrigger>
              <TooltipContent>
                {humanDuration(gap.durationSec)} · {formatClock(gap.start)}–{formatClock(gap.end)} ·{' '}
                {CAUSE_LABEL[gap.cause]}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>

      <div
        className="text-muted-foreground relative h-4 text-[11px] tabular-nums"
        aria-hidden="true"
      >
        {TICKS.map((tick) => (
          <span
            key={tick}
            className={cn(
              'absolute',
              tick === 0 && 'translate-x-0',
              tick === TICKS.length - 1 && '-translate-x-full',
              tick > 0 && tick < TICKS.length - 1 && '-translate-x-1/2',
            )}
            style={{ left: `${(tick / (TICKS.length - 1)) * 100}%` }}
          >
            {formatClock(
              new Date(dayStart + (dayLength * tick) / (TICKS.length - 1)).toISOString(),
            )}
          </span>
        ))}
      </div>

      <ul className="text-muted-foreground flex flex-wrap items-center gap-4 text-xs">
        <LegendKey className="bg-emerald-500" label="Recorded" />
        <LegendKey className="bg-destructive/85" label="Gap" />
        {truncated && <LegendKey className="bg-muted" label="Not yet elapsed" />}
      </ul>

      {data.clamped && (
        <p className="text-sm text-amber-600 dark:text-amber-500">
          MediaMTX reported {humanDuration(data.clamped.excessSec)} of footage past the present
          across {data.clamped.spanCount} span{data.clamped.spanCount === 1 ? '' : 's'}. The
          timeline stops at now rather than trusting it.
        </p>
      )}

      {/* The list, not the bar, is the representation that survives without a
          pointer: Radix tooltips do not open on touch, and a sliver is not a
          screen-reader target. Same facts, same order. */}
      {data.gaps.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No gaps longer than 2 seconds in this window.
        </p>
      ) : (
        <ol className="divide-border divide-y text-sm">
          {data.gaps.map((gap) => (
            <li key={gap.start} className="flex flex-wrap items-baseline gap-x-3 py-2">
              <span className="tabular-nums">
                {formatClock(gap.start)}–{formatClock(gap.end)}
              </span>
              <span className="font-medium tabular-nums">{humanDuration(gap.durationSec)}</span>
              <span className="text-muted-foreground">{CAUSE_LABEL[gap.cause]}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function LegendKey({ className, label }: { className: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className={cn('inline-block h-2.5 w-2.5 rounded-sm', className)} aria-hidden="true" />
      {label}
    </li>
  )
}

/**
 * Coverage as a percentage, with one refusal: never 100.00% while a gap is
 * listed. A two-second hole in a day is 99.9977%, which rounds up at two
 * decimals, and a perfect score printed beside visible holes is precisely the
 * contradiction this page exists to avoid.
 */
function formatCoverage(coverage: number, hasGaps: boolean): string {
  const percent = coverage * 100
  if (hasGaps && percent > 99.99) return '>99.99%'
  return `${percent.toFixed(2)}%`
}
