'use client'

import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilmIcon,
  PlayIcon,
  TriangleAlertIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipPlayer } from '@/components/clip-player'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type TimelineGap, type TimelineSpan } from '@/lib/api'
import {
  formatClock,
  formatClockSeconds,
  formatDay,
  humanDuration,
  localMidnightMs,
  shiftDay,
} from '@/lib/camera-time'
import { formatCoverage } from '@/lib/format'
import { useQuery } from '@tanstack/react-query'
import { isTypingTarget } from '@/lib/keys'
import { cn } from '@/lib/utils'

// docs/ARCHITECTURE.md#timeline-gaps-and-coverage: a gap must never render as
// continuous recording. Everything below follows from that one sentence — the
// gap-coloured track, the third state for hours that have not happened, the
// refusal to print 100%, and the lists that say the same thing without needing
// a mouse.

const CAUSE_LABEL: Record<TimelineGap['cause'], string> = {
  camera_down: 'camera down',
  unknown: 'unknown',
}

// Ticks land on round times, not on fifths of whatever happens to be on
// screen: zoomed to 45 minutes, evenly-spaced ticks read 14:02 / 14:13 / 14:24,
// which is a scale nobody can use to find 14:30.
const TICK_STEPS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  3_600_000,
  2 * 3_600_000,
  3 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000,
]

// The coarsest step that still puts at least a handful of labels on the bar.
const tickStep = (lenMs: number) =>
  TICK_STEPS_MS.find((step) => lenMs / step <= 8) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!

// The clip route's own default (SPEC 4.5). Sent explicitly so the window the
// caption promises is the window the player asks for.
const CLIP_DURATION_SEC = 300

// Five minutes is as far in as the track goes. Past that a 10-minute segment
// no longer fits on screen, so the picture stops being about recording runs and
// starts being about pixels.
const MIN_VIEW_MS = 5 * 60_000

// Under a quarter of an hour on screen, ticks that print only HH:MM would
// repeat themselves.
const SECONDS_TICKS_BELOW_MS = 15 * 60_000

// recordDeleteAfter is 168h (docs/ARCHITECTURE.md#the-media-pipeline).
const RETENTION_DAYS = 7

// Buttons and keys step further than the wheel: a wheel notch should feel
// continuous, a click should get somewhere.
const ZOOM = { in: 0.6, out: 1.7, wheelIn: 0.8, wheelOut: 1.25, double: 0.4 }

// What a click resolved to. `gap` carries the instant rather than the gap so the
// message can name the moment the operator actually clicked.
type Selection = { kind: 'clip' | 'gap'; startMs: number }

/**
 * The span covering an instant, or undefined. Half-open to match the API: the
 * instant at a span's end is already the gap after it.
 */
const spanCovering = (spans: TimelineSpan[], ms: number) =>
  spans.find((span) => ms >= Date.parse(span.start) && ms < Date.parse(span.end))

/** The visible window, as an offset and a length within the day. */
type View = { start: number; len: number }

const clampView = (start: number, len: number, dayLength: number): View => {
  const bounded = Math.max(MIN_VIEW_MS, Math.min(dayLength, len))
  return { start: Math.max(0, Math.min(dayLength - bounded, start)), len: bounded }
}

/** The zoom readout: "24h", "6h", "45m", "5m". */
function zoomLabel(len: number): string {
  const seconds = Math.round(len / 1000)
  if (seconds >= 86_400) return '24h'
  if (seconds >= 3_600) {
    const hours = seconds / 3_600
    return `${hours % 1 === 0 ? hours : hours.toFixed(1)}h`
  }
  return `${Math.max(1, Math.round(seconds / 60))}m`
}

export function Timeline({
  slug,
  today,
  initialDay,
  initialAtMs,
}: {
  slug: string
  today: string
  initialDay?: string
  initialAtMs?: number
}) {
  const [day, setDay] = useState(initialDay ?? today)
  const [selection, setSelection] = useState<Selection | null>(null)
  // null means the whole day. Storing it that way rather than as an explicit
  // {0, dayLength} keeps "reset" a single assignment and survives a day whose
  // length is not 24 hours.
  const [view, setView] = useState<View | null>(null)
  const [hoverMs, setHoverMs] = useState<number | null>(null)

  // The ?at= jump can only be resolved once the day's spans are here, and it
  // must happen exactly once — re-applying it would fight every later click.
  const jumpedRef = useRef(false)
  const trackRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<{ fraction: number; start: number } | null>(null)
  // Set when a shift-drag actually moved the view, and read by the click
  // handler so releasing a pan does not also select the instant under the
  // cursor.
  const pannedRef = useRef(false)

  // Pure functions of the selected day, and deliberately not of Date.now():
  // a clock reading here would change the query key on every render and
  // refetch forever. What has actually elapsed is the server's answer, below.
  const dayStart = localMidnightMs(day)
  const dayEnd = localMidnightMs(shiftDay(day, 1))
  const dayLength = dayEnd - dayStart

  // A selection is a position within one day. Carrying it across a day change
  // would leave the player showing yesterday under today's bar; the zoom goes
  // with it, because a window into 03:00–04:00 of one day says nothing about
  // the next.
  const goToDay = useCallback((next: string) => {
    setDay(next)
    setSelection(null)
    setView(null)
    setHoverMs(null)
  }, [])

  const { data, isPending, isError } = useQuery({
    queryKey: ['timeline', slug, day],
    queryFn: async ({ signal }) => {
      const res = await api.recordings[':slug'].timeline.$get(
        {
          param: { slug },
          // The whole local day, every time. The server clamps the end to its
          // own `now` and reports what it used, so "has this hour happened?" is
          // never decided by a browser clock that may be minutes off.
          //
          // Zooming does NOT refetch: the day is already here, and asking the
          // API for a narrower window would only re-derive spans it has already
          // sent — with a round trip in the middle of a wheel gesture.
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

  useEffect(() => {
    if (jumpedRef.current || initialAtMs === undefined || !data) return
    jumpedRef.current = true
    setSelection({
      kind: spanCovering(data.spans, initialAtMs) ? 'clip' : 'gap',
      startMs: initialAtMs,
    })
  }, [data, initialAtMs])

  const zoomAt = useCallback(
    (fraction: number, factor: number) => {
      setView((current) => {
        const from = current ?? { start: 0, len: dayLength }
        const anchor = from.start + fraction * from.len
        const len = Math.max(MIN_VIEW_MS, Math.min(dayLength, from.len * factor))
        // The instant under the cursor stays under the cursor. Zooming about
        // the centre instead is the difference between inspecting a gap and
        // chasing it around the bar.
        return clampView(anchor - fraction * len, len, dayLength)
      })
    },
    [dayLength],
  )

  const fractionOf = useCallback((event: { clientX: number }) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
  }, [])

  // Wheel is registered by hand because React's onWheel is passive: it cannot
  // call preventDefault, so the page would scroll behind every zoom.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      zoomAt(fractionOf(event), event.deltaY > 0 ? ZOOM.wheelOut : ZOOM.wheelIn)
    }

    track.addEventListener('wheel', onWheel, { passive: false })
    return () => track.removeEventListener('wheel', onWheel)
  }, [zoomAt, fractionOf, isPending, isError])

  const gaps = data?.gaps
  const atToday = day >= today

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault()
          goToDay(shiftDay(day, -1))
          return
        case 'ArrowRight':
          if (atToday) return
          event.preventDefault()
          goToDay(shiftDay(day, 1))
          return
        case '+':
        case '=':
          event.preventDefault()
          zoomAt(0.5, ZOOM.in)
          return
        case '-':
        case '_':
          event.preventDefault()
          zoomAt(0.5, ZOOM.out)
          return
        case '0':
          event.preventDefault()
          setView(null)
          return
        case 'g':
        case 'G': {
          if (!gaps?.length) return
          event.preventDefault()
          setView((current) => {
            const from = current ?? { start: 0, len: dayLength }
            const cursor = from.start + from.len / 2
            // Wraps, so repeated presses walk the day's gaps in a loop rather
            // than sticking on the last one.
            const next = gaps.find((gap) => Date.parse(gap.start) - dayStart > cursor) ?? gaps[0]
            if (!next) return current

            // Framed with half its own length of context either side, so the
            // gap is legible AND you can see what it interrupted.
            const gapStart = Date.parse(next.start) - dayStart
            const gapEnd = Date.parse(next.end) - dayStart
            const len = Math.max(MIN_VIEW_MS, (gapEnd - gapStart) * 2)
            return clampView((gapStart + gapEnd) / 2 - len / 2, len, dayLength)
          })
          return
        }
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [day, atToday, dayLength, dayStart, gaps, goToDay, zoomAt])

  const picker = (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="icon"
        className="size-[34px]"
        aria-label="Previous day"
        title="Previous day (←)"
        onClick={() => goToDay(shiftDay(day, -1))}
      >
        <ChevronLeftIcon className="size-[15px]" />
      </Button>

      <label className="bg-card flex h-[34px] cursor-pointer items-center gap-2.5 rounded-md border px-3">
        <CalendarIcon className="text-muted-foreground size-3.5" aria-hidden />
        {/* The control renders in the BROWSER's locale, so the camera-local
            spelling sits beside it and the input itself is visually hidden
            behind it. */}
        <span className="text-[13.5px] font-medium tabular-nums">{formatDay(day)}</span>
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
          className="sr-only"
        />
      </label>

      <Button
        variant="outline"
        size="icon"
        className="size-[34px]"
        aria-label="Next day"
        title="Next day (→)"
        disabled={atToday}
        onClick={() => goToDay(shiftDay(day, 1))}
      >
        <ChevronRightIcon className="size-[15px]" />
      </Button>

      {atToday ? null : (
        <Button variant="ghost" size="sm" className="ml-1 h-[34px]" onClick={() => goToDay(today)}>
          Today
        </Button>
      )}
    </div>
  )

  if (isPending) {
    return (
      <Shell>
        {picker}
        <Skeleton className="h-[78px] w-full rounded-md" />
      </Shell>
    )
  }

  if (isError) {
    return (
      <Shell>
        {picker}
        <p className="text-muted-foreground text-sm">
          Could not load the timeline for this day. The API may be unreachable, or the session may
          have expired.
        </p>
      </Shell>
    )
  }

  const windowEnd = Date.parse(data.window.to)
  const notYetMs = Math.max(0, dayEnd - windowEnd)
  const truncated = notYetMs > 0
  const current = view ?? { start: 0, len: dayLength }

  // Percentages within the VIEW, and clipped to it. Clipping rather than
  // letting a span overflow an overflow-hidden box matters for more than
  // tidiness: a clipped element's centre is always a point inside the visible
  // track, so "click the middle of this span" resolves to an instant the span
  // actually covers at every zoom level.
  const pos = (ms: number) => ((ms - dayStart - current.start) / current.len) * 100
  const box = (fromMs: number, toMs: number) => {
    const left = Math.max(0, pos(fromMs))
    const right = Math.min(100, pos(toMs))
    return right <= left ? null : { left, width: right - left }
  }

  const describe = (gap: TimelineGap) =>
    `Gap, ${humanDuration(gap.durationSec)}, from ${formatClock(gap.start)} to ${formatClock(gap.end)}, cause: ${CAUSE_LABEL[gap.cause]}`

  // Spans arrive merged and clipped to the window, so this is the same list the
  // bar draws and the same one the API resolves a clip against.
  const spanAt = (ms: number) => spanCovering(data.spans, ms)

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

  // The inverse of pos(): a pixel offset back into a wall-clock instant. Read
  // off the element rather than a stored width so it survives a resize with no
  // listener.
  const instantAt = (fraction: number) => dayStart + current.start + fraction * current.len

  const selectFromClick = (event: React.MouseEvent<HTMLElement>) => {
    // A shift-drag that moved the view ends in a click on the track. Without
    // this the pan would also seek, every time.
    if (pannedRef.current) {
      pannedRef.current = false
      return
    }
    select(instantAt(fractionOf(event)))
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.shiftKey) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = { fraction: fractionOf(event), start: current.start }
    pannedRef.current = false
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const fraction = fractionOf(event)
    setHoverMs(instantAt(fraction))

    const pan = panRef.current
    if (!pan) return

    pannedRef.current = true
    setView(clampView(pan.start - (fraction - pan.fraction) * current.len, current.len, dayLength))
  }

  const endPan = () => {
    panRef.current = null
  }

  // The day is older than retention AND nothing came back, which together mean
  // the segments were deleted rather than never written. The nightly snapshot
  // outlives them, so this points at Health instead of showing a bar of zero.
  const outsideRetention = day < shiftDay(today, -RETENTION_DAYS) && data.spans.length === 0

  const notElapsed = truncated ? box(windowEnd, dayEnd) : null
  const playheadPercent = selection ? pos(selection.startMs) : null
  const hoverPercent = hoverMs !== null ? pos(hoverMs) : null
  const ticksInSeconds = current.len < SECONDS_TICKS_BELOW_MS

  const step = tickStep(current.len)
  const ticks: number[] = []
  for (
    let offset = Math.ceil(current.start / step) * step;
    offset <= current.start + current.len;
    offset += step
  ) {
    ticks.push(offset)
  }

  return (
    <div className="px-7 pt-5 pb-8">
      <div className="flex max-w-[1560px] flex-col gap-[18px]">
        <div className="flex flex-wrap items-center gap-3.5">
          {picker}

          <div className="ml-auto flex items-center gap-5">
            <div className="text-right">
              <div className="text-[26px] leading-none font-bold tabular-nums">
                {formatCoverage(data.coverage, data.gaps.length > 0)}
              </div>
              <div className="text-muted-foreground mt-1 text-[11.5px]">
                {truncated ? 'covered, of the day so far' : 'covered'}
              </div>
            </div>
            <div aria-hidden className="bg-border h-[34px] w-px" />
            <div className="text-right">
              <div className="text-[26px] leading-none font-bold tabular-nums">
                {data.gaps.length}
              </div>
              <div className="text-muted-foreground mt-1 text-[11.5px]">
                {data.gaps.length === 1 ? 'gap over 2s' : 'gaps over 2s'}
              </div>
            </div>
          </div>
        </div>

        {outsideRetention ? (
          <div className="bg-card flex flex-col items-start gap-3 rounded-xl border border-dashed p-8">
            <FilmIcon className="text-muted-foreground size-6" aria-hidden />
            <p className="text-[15px] font-semibold">No footage for {formatDay(day)}.</p>
            <p className="text-muted-foreground max-w-[70ch] text-[13px] leading-relaxed">
              That day is past the {RETENTION_DAYS * 24}-hour retention window, so MediaMTX has
              deleted the segments. The coverage snapshot survives it — written nightly and kept
              after the footage is gone — so Health can still say what that day managed.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => goToDay(today)}>
                Back to today
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/health">See the snapshot</Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid items-start gap-[18px] xl:grid-cols-[minmax(0,1fr)_clamp(280px,26%,360px)]">
            <div className="flex min-w-0 flex-col gap-3.5">
              {selection?.kind === 'clip' ? (
                <ClipPlayer
                  key={selection.startMs}
                  slug={slug}
                  startMs={selection.startMs}
                  durationSec={CLIP_DURATION_SEC}
                />
              ) : selection?.kind === 'gap' ? (
                /* SPEC 4.5: the click that lands in a hole gets an explanation
                   and a way out, never an empty <video>. This is the same
                   verdict the API's 409 reaches — from the same spans, by the
                   same rule — reached here so it arrives without a round trip. */
                <NoFootage
                  at={selection.startMs}
                  elapsed={selection.startMs <= windowEnd}
                  nearest={nearestSpan(selection.startMs)}
                  onPlay={select}
                />
              ) : (
                <EmptyPlayer />
              )}

              <div className="bg-card rounded-xl border px-4.5 pt-4 pb-3.5">
                <div className="mb-3 flex items-center gap-3">
                  <div className="text-[13px] font-semibold">Day timeline</div>
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-muted-foreground text-[11.5px]">window</span>
                    <span
                      data-testid="timeline-zoom"
                      className="min-w-[52px] text-center font-mono text-xs font-semibold tabular-nums"
                    >
                      {zoomLabel(current.len)}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-7"
                      aria-label="Zoom out"
                      title="Zoom out (−)"
                      onClick={() => zoomAt(0.5, ZOOM.out)}
                    >
                      <ZoomOutIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-7"
                      aria-label="Zoom in"
                      title="Zoom in (+)"
                      onClick={() => zoomAt(0.5, ZOOM.in)}
                    >
                      <ZoomInIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      title="Whole day (0)"
                      onClick={() => setView(null)}
                    >
                      Whole day
                    </Button>
                  </div>
                </div>

                <div className="relative">
                  {hoverPercent !== null && hoverMs !== null ? (
                    <div
                      aria-hidden
                      className="bg-foreground text-background pointer-events-none absolute bottom-full z-30 -translate-x-1/2 -translate-y-2 rounded-md px-2.5 py-1.5 text-[11.5px] font-medium whitespace-nowrap shadow-lg"
                      style={{ left: `${hoverPercent}%` }}
                    >
                      {formatClockSeconds(new Date(hoverMs).toISOString())}
                    </div>
                  ) : null}

                  {/* The track IS the gap colour and spans are painted on top,
                      rather than drawing a gap element per hole. A gap too
                      narrow to occupy a pixel then still shows as a hairline of
                      background instead of vanishing — which is the one failure
                      mode this bar may not have.

                      Clickable, but still aria-hidden and not focusable: a
                      24-hour strip of pixels is not a control anybody can
                      operate without a pointer. The "Recorded spans" list is
                      the equivalent path, the same way the gap list already
                      is. */}
                  <div
                    ref={trackRef}
                    className="bg-destructive relative h-[78px] w-full cursor-crosshair touch-none overflow-hidden rounded-md select-none"
                    aria-hidden="true"
                    data-testid="timeline-track"
                    onClick={selectFromClick}
                    onDoubleClick={(event) => zoomAt(fractionOf(event), ZOOM.double)}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={endPan}
                    onPointerCancel={endPan}
                    onPointerLeave={() => {
                      endPan()
                      setHoverMs(null)
                    }}
                  >
                    {data.spans.map((span) => {
                      const rect = box(Date.parse(span.start), Date.parse(span.end))
                      if (!rect) return null

                      return (
                        <div
                          key={span.start}
                          // The bar is aria-hidden, so an end-to-end test has
                          // no role to locate it by. It clicks this, which is
                          // the pixel an operator clicks
                          // (docs/ARCHITECTURE.md#playback).
                          data-testid="timeline-span"
                          className="bg-rec absolute inset-y-0"
                          style={{ left: `${rect.left}%`, width: `${rect.width}%` }}
                        />
                      )
                    })}

                    {notElapsed ? (
                      <div
                        data-testid="timeline-not-elapsed"
                        className="bg-future absolute inset-y-0"
                        style={{ left: `${notElapsed.left}%`, width: `${notElapsed.width}%` }}
                      />
                    ) : null}

                    {playheadPercent !== null && playheadPercent >= 0 && playheadPercent <= 100 ? (
                      <div
                        className="bg-foreground absolute inset-y-0 -ml-px w-0.5 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                        style={{ left: `${playheadPercent}%` }}
                      />
                    ) : null}
                  </div>

                  {/* Hit targets, sized independently of the picture. The visual
                      gap keeps its true width; this is a 14px-minimum target
                      centred on it, so a 20-second hole stays reachable without
                      being drawn as minutes. Focusable, so it is reachable from
                      the keyboard. */}
                  {data.gaps.map((gap) => {
                    const rect = box(Date.parse(gap.start), Date.parse(gap.end))
                    if (!rect) return null

                    return (
                      <button
                        key={gap.start}
                        type="button"
                        aria-label={describe(gap)}
                        title={`${humanDuration(gap.durationSec)} · ${formatClock(gap.start)}–${formatClock(gap.end)} · ${CAUSE_LABEL[gap.cause]}`}
                        // Handled here rather than left to bubble into the
                        // track: the hit target is widened, so a click near the
                        // edge of a 20-second hole would otherwise resolve to
                        // the span beside it and start playing footage the
                        // label just called a gap.
                        onClick={() => select(Date.parse(gap.start))}
                        className="focus-visible:ring-ring absolute inset-y-0 min-w-3.5 -translate-x-1/2 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
                        style={{
                          left: `${rect.left + rect.width / 2}%`,
                          width: `${rect.width}%`,
                          height: 78,
                        }}
                      />
                    )
                  })}

                  <div
                    className="text-muted-foreground relative mt-1.5 h-5 font-mono text-[11px] tabular-nums"
                    aria-hidden="true"
                  >
                    {ticks.map((offset) => {
                      const percent = ((offset - current.start) / current.len) * 100
                      const at = new Date(dayStart + offset).toISOString()

                      return (
                        <span
                          key={offset}
                          className={cn(
                            'absolute whitespace-nowrap',
                            // Nudged in at the ends so the first and last
                            // labels are not half-clipped by the card.
                            percent < 2
                              ? 'translate-x-0'
                              : percent > 98
                                ? '-translate-x-full'
                                : '-translate-x-1/2',
                          )}
                          style={{ left: `${percent}%` }}
                        >
                          {ticksInSeconds ? formatClockSeconds(at) : formatClock(at)}
                        </span>
                      )
                    })}
                  </div>
                </div>

                <ul className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-4 text-[11.5px]">
                  <LegendKey className="bg-rec" label="Recorded" />
                  <LegendKey className="bg-destructive" label="Gap" />
                  {truncated ? <LegendKey className="bg-future" label="Not yet elapsed" /> : null}
                  <li className="ml-auto hidden lg:list-item">
                    The track is the gap colour and the footage is painted on top, so a two-second
                    hole stays a visible hairline.
                  </li>
                </ul>

                {data.clamped ? (
                  <p className="mt-3 text-sm text-amber-600 dark:text-amber-500">
                    MediaMTX reported {humanDuration(data.clamped.excessSec)} of footage past the
                    present across {data.clamped.spanCount} span
                    {data.clamped.spanCount === 1 ? '' : 's'}. The timeline stops at now rather than
                    trusting it.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-3.5 xl:sticky xl:top-0">
              <Panel
                title="Gaps"
                badge={
                  <span className="bg-destructive text-destructive-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums">
                    {data.gaps.length}
                  </span>
                }
              >
                {/* The list, not the bar, is the representation that survives
                    without a pointer: a sliver is not a screen-reader target.
                    Same facts, same order. */}
                {data.gaps.length === 0 ? (
                  <p className="text-muted-foreground p-4 text-[12.5px] leading-relaxed">
                    No gaps longer than 2 seconds in this window. Anything shorter is a muxer
                    boundary between segments, not a hole in the record.
                  </p>
                ) : (
                  <ol>
                    {data.gaps.map((gap) => (
                      <li key={gap.start}>
                        <button
                          type="button"
                          onClick={() => select(Date.parse(gap.start))}
                          className="hover:bg-muted flex w-full items-center gap-2.5 border-b px-4 py-2.5 text-left last:border-b-0"
                        >
                          <span
                            aria-hidden
                            className="bg-destructive w-[3px] self-stretch rounded-sm"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-mono text-[12.5px] tabular-nums">
                              {formatClock(gap.start)}–{formatClock(gap.end)}
                            </span>
                            <span className="text-muted-foreground mt-0.5 block text-[11px]">
                              {CAUSE_LABEL[gap.cause]}
                            </span>
                          </span>
                          <span className="text-[12.5px] font-semibold tabular-nums">
                            {humanDuration(gap.durationSec)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>

              {/* The pointer-free half of the bar, for the same reason the gap
                  list is: the track is a strip of pixels nobody can click
                  without a mouse. Every span the bar draws is reachable and
                  playable from here. */}
              <Panel
                title="Recorded spans"
                badge={
                  <span className="text-muted-foreground ml-auto text-[11px]">
                    keyboard-reachable
                  </span>
                }
              >
                {data.spans.length === 0 ? (
                  <p className="text-muted-foreground p-4 text-[12.5px] leading-relaxed">
                    Nothing was recorded on this day.
                  </p>
                ) : (
                  <ol>
                    {data.spans.map((span) => (
                      <li
                        key={span.start}
                        className="flex items-center gap-2.5 border-b px-4 py-2.5 last:border-b-0"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono text-[12.5px] tabular-nums">
                            {formatClock(span.start)}–{formatClock(span.end)}
                          </span>
                          <span className="text-muted-foreground mt-0.5 block text-[11px]">
                            {humanDuration(span.durationSec)}
                          </span>
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          // The visible label is short enough for a 280px
                          // column; the accessible name still names the instant
                          // it plays from, which is what a screen reader — and
                          // e2e/signed-in/clip.spec.ts — reads.
                          aria-label={`Play from ${formatClock(span.start)}`}
                          onClick={() => select(Date.parse(span.start))}
                        >
                          <PlayIcon className="size-2.5 fill-current" />
                          Play
                        </Button>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-7 pt-5 pb-8">
      <div className="flex max-w-[1560px] flex-col gap-[18px]">{children}</div>
    </div>
  )
}

function Panel({
  title,
  badge,
  children,
}: {
  title: string
  badge?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-card overflow-hidden rounded-xl border">
      <div className="flex items-center gap-2 border-b px-4 py-3.5">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {badge}
      </div>
      {children}
    </section>
  )
}

function EmptyPlayer() {
  return (
    // Deliberately NOT role="status". e2e/signed-in/clip.spec.ts locates the
    // gap explanation by that role, and a second live region on this page would
    // make the locator ambiguous — which is the sort of thing that turns a
    // passing suite into a flaky one.
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-xl border bg-[#0b0d12] p-9 text-center">
      <FilmIcon className="size-6 text-white/45" aria-hidden />
      <p className="text-sm text-white/80">Click anywhere on the day to play that moment.</p>
      <p className="max-w-[54ch] text-xs leading-relaxed text-white/50">
        Scroll to zoom under the cursor, shift-drag to pan, double-click to zoom in. A click that
        lands in a gap says so instead of handing you an empty player.
      </p>
    </div>
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
      className="relative flex aspect-video w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border bg-[oklch(0.70_0.18_22_/_0.10)] p-9 text-center"
    >
      {/* Hazard stripes rather than a flat wash: a gap is the one thing on this
          screen that must never be mistaken for footage that happens to be
          dark. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'repeating-linear-gradient(45deg,oklch(0.70 0.18 22 / 0.14) 0 10px,transparent 10px 20px)',
        }}
      />
      <TriangleAlertIcon className="text-destructive relative size-6" aria-hidden />
      <p className="relative text-base font-semibold">
        {elapsed
          ? `Nothing was recorded at ${when}. That part of the day is a gap.`
          : `${when} has not happened yet.`}
      </p>
      {nearest ? (
        <>
          <p className="text-muted-foreground relative max-w-[56ch] text-[13px] leading-relaxed">
            Nearest footage: {formatClock(nearest.start)}–{formatClock(nearest.end)} (
            {humanDuration(nearest.durationSec)}).
          </p>
          <Button className="relative" size="sm" onClick={() => onPlay(Date.parse(nearest.start))}>
            <PlayIcon className="size-3 fill-current" />
            Play from {formatClock(nearest.start)}
          </Button>
        </>
      ) : (
        <p className="text-muted-foreground relative text-[13px]">
          There is no footage at all for this day.
        </p>
      )}
    </div>
  )
}

function LegendKey({ className, label }: { className: string; label: string }) {
  return (
    <li className="flex items-center gap-[7px]">
      <span className={cn('inline-block size-2.5 rounded-[3px]', className)} aria-hidden="true" />
      {label}
    </li>
  )
}
