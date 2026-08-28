'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ClipPlayer } from '@/components/clip-player'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { api, type TimelineGap, type TimelineSpan } from '@/lib/api'
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

// The clip route's own default (SPEC 4.5). Sent explicitly so the window the
// caption promises is the window the player asks for.
const CLIP_DURATION_SEC = 300

// What a click resolved to. `gap` carries the instant rather than the gap so the
// message can name the moment the operator actually clicked.
type Selection = { kind: 'clip' | 'gap'; startMs: number }

export function Timeline({ slug, today }: { slug: string; today: string }) {
  const [day, setDay] = useState(today)
  const [selection, setSelection] = useState<Selection | null>(null)

  // A selection is a position within one day. Carrying it across a day change
  // would leave the player showing yesterday under today's bar.
  const goToDay = (next: string) => {
    setDay(next)
    setSelection(null)
  }

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
        <Button variant="outline" size="sm" onClick={() => goToDay(shiftDay(day, -1))}>
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
            if (next && next <= today) goToDay(next)
          }}
          aria-label="Day to show"
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={atToday}
          onClick={() => goToDay(shiftDay(day, 1))}
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

  // Spans arrive merged and clipped to the window, so this is the same list the
  // bar draws and the same one the API resolves a clip against. Half-open to
  // match: the instant at a span's end is already the gap after it.
  const spanAt = (ms: number) =>
    data.spans.find((span) => ms >= Date.parse(span.start) && ms < Date.parse(span.end))

  // The client half of the 409. The API is the authority and answers the same
  // way for any caller, but it already sent the spans this decision needs, so
  // asking it again would only add a round trip before saying "no footage".
  //
  // Measured to the nearer EDGE, and a tie goes to the later span, matching
  // nearestSpan() in the API's timeline module.
  const nearestSpan = (ms: number): TimelineSpan | null => {
    let nearest: TimelineSpan | null = null
    let distance = Infinity

    for (const span of data.spans) {
      const start = Date.parse(span.start)
      const away = ms < start ? start - ms : Math.max(0, ms - Date.parse(span.end))

      if (away <= distance) {
        nearest = span
        distance = away
      }
    }

    return nearest
  }

  const select = (ms: number) =>
    setSelection({ kind: spanAt(ms) ? 'clip' : 'gap', startMs: Math.round(ms) })

  // The inverse of left(): a pixel offset back into a wall-clock instant. Read
  // off the element rather than a stored width so it survives a resize with no
  // listener.
  const selectFromClick = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)

    select(dayStart + fraction * dayLength)
  }

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
              vanishing — which is the one failure mode this bar may not have.

              Clickable, but still aria-hidden and not focusable: a 24-hour
              strip of pixels is not a control anybody can operate without a
              pointer. The "Recorded spans" list below is the equivalent path,
              the same way the gap list already is. */}
          <div
            className="bg-destructive/85 relative h-12 w-full cursor-pointer overflow-hidden rounded-md"
            aria-hidden="true"
            data-testid="timeline-track"
            onClick={selectFromClick}
          >
            {data.spans.map((span) => (
              <div
                key={span.start}
                // The bar is aria-hidden, so an end-to-end test has no role to
                // locate it by. It clicks this, which is the pixel an operator
                // clicks (docs/ARCHITECTURE.md#playback).
                data-testid="timeline-span"
                className="absolute inset-y-0 bg-emerald-500"
                style={{ left: `${left(span.start)}%`, width: `${width(span.start, span.end)}%` }}
              />
            ))}
            {truncated && (
              <div
                data-testid="timeline-not-elapsed"
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
                  // Handled here rather than left to bubble into the track: the
                  // hit target is widened to 12px, so a click near the edge of
                  // a 20-second hole would otherwise resolve to the span beside
                  // it and start playing footage the tooltip just called a gap.
                  onClick={() => select(Date.parse(gap.start))}
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

      {selection?.kind === 'clip' && (
        <ClipPlayer
          key={selection.startMs}
          slug={slug}
          startMs={selection.startMs}
          durationSec={CLIP_DURATION_SEC}
        />
      )}

      {/* SPEC 4.5: the click that lands in a hole gets an explanation and a way
          out, never an empty <video>. This is the same verdict the API's 409
          reaches — from the same spans, by the same rule — reached here so it
          arrives without a round trip. */}
      {selection?.kind === 'gap' && (
        <NoFootage
          at={selection.startMs}
          elapsed={selection.startMs <= windowEnd}
          nearest={nearestSpan(selection.startMs)}
          onPlay={select}
        />
      )}

      {data.clamped && (
        <p className="text-sm text-amber-600 dark:text-amber-500">
          MediaMTX reported {humanDuration(data.clamped.excessSec)} of footage past the present
          across {data.clamped.spanCount} span{data.clamped.spanCount === 1 ? '' : 's'}. The
          timeline stops at now rather than trusting it.
        </p>
      )}

      {/* The pointer-free half of the bar, for the same reason the gap list
          below is: the track is a strip of pixels nobody can click without a
          mouse. Every span the bar draws is reachable and playable from here. */}
      {data.spans.length > 0 && (
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Recorded spans</h2>
          <ol className="divide-border divide-y text-sm">
            {data.spans.map((span) => (
              <li key={span.start} className="flex flex-wrap items-baseline gap-x-3 py-2">
                <span className="tabular-nums">
                  {formatClock(span.start)}–{formatClock(span.end)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {humanDuration(span.durationSec)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => select(Date.parse(span.start))}
                >
                  Play from {formatClock(span.start)}
                </Button>
              </li>
            ))}
          </ol>
        </div>
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

function NoFootage({
  at,
  elapsed,
  nearest,
  onPlay,
}: {
  at: number
  elapsed: boolean
  nearest: TimelineSpan | null
  onPlay: (ms: number) => void
}) {
  const when = formatClock(new Date(at).toISOString())

  return (
    <div
      role="status"
      className="border-destructive/40 bg-destructive/5 space-y-3 rounded-md border p-4 text-sm"
    >
      <p>
        {elapsed
          ? `Nothing was recorded at ${when}. That part of the day is a gap.`
          : `${when} has not happened yet.`}
      </p>
      {nearest ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-muted-foreground">
            Nearest footage: {formatClock(nearest.start)}–{formatClock(nearest.end)} (
            {humanDuration(nearest.durationSec)}).
          </p>
          <Button size="sm" onClick={() => onPlay(Date.parse(nearest.start))}>
            Play from {formatClock(nearest.start)}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">There is no footage at all for this day.</p>
      )}
    </div>
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
export function formatCoverage(coverage: number, hasGaps: boolean): string {
  const percent = coverage * 100
  if (hasGaps && percent > 99.99) return '>99.99%'
  return `${percent.toFixed(2)}%`
}
