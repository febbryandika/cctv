'use client'

import { ClockIcon } from 'lucide-react'
import { CAMERA_TZ, formatClockSeconds } from '@/lib/camera-time'
import { useNow } from '@/lib/use-now'

// "WIB" for Asia/Jakarta, and the last path segment for anything else. The
// label is what makes the readout unambiguous: an operator in another zone
// needs to know this clock is the CAMERA's, not theirs
// (docs/ARCHITECTURE.md#timeline-gaps-and-coverage).
const ZONE_LABEL = CAMERA_TZ === 'Asia/Jakarta' ? 'WIB' : CAMERA_TZ.split('/').pop()

/**
 * The camera's wall clock, ticking.
 *
 * Every timestamp on every screen is in this zone, and the operator's machine
 * may not be. A running clock in the chrome is the cheapest way to keep that
 * fact in view — and it ticks in seconds because a readout frozen at HH:MM is
 * indistinguishable from a page that has stopped updating.
 */
export function WibClock() {
  const now = useNow(1_000)

  return (
    <div className="text-secondary-foreground flex h-8 items-center gap-[7px] rounded-md border px-[11px] text-[13px] tabular-nums">
      <ClockIcon className="size-3.5" aria-hidden />
      {/* Reserved with a placeholder rather than left empty: the clock is read
          on the client only, and a zero-width box that suddenly becomes eight
          characters wide shifts the whole header on hydration. */}
      <span>{now === null ? '--:--:--' : formatClockSeconds(new Date(now).toISOString())}</span>
      <span className="text-muted-foreground text-[11px]">{ZONE_LABEL}</span>
    </div>
  )
}
