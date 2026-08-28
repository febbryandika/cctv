'use client'

import { ExternalLinkIcon } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/lib/api'
import { formatClock, formatClockSeconds, humanDuration } from '@/lib/camera-time'
import { formatBytes } from '@/lib/format'
import { useHealth } from '@/lib/queries'
import { cn } from '@/lib/utils'

// Plays a [start, duration] window served by the clip proxy
// (docs/ARCHITECTURE.md#playback). Deliberately thin: MediaMTX stitches across
// segment boundaries and the proxy asks it for format=mp4, so the moov carries
// a real duration and the browser's own controls do the seeking. A custom
// scrubber would be a second implementation of something that already works —
// and would have to reimplement buffering and seeking to be as good.

type Status = 'loading' | 'playing' | 'error'

export function ClipPlayer({
  slug,
  startMs,
  durationSec,
}: {
  slug: string
  startMs: number
  durationSec: number
}) {
  const [status, setStatus] = useState<Status>('loading')
  const health = useHealth()

  const startIso = new Date(startMs).toISOString()

  // Built through the typed client rather than by hand, so a rename of the
  // route is a compile error here instead of a 404 at runtime.
  const src = api.recordings[':slug'].clip
    .$url({ param: { slug }, query: { start: startIso, duration: String(durationSec) } })
    .toString()

  // From the rate the disk actually recorded at over the last 24h, not from a
  // configured bitrate. Approximate by construction, and marked as such.
  const bytesPerHour = health.data?.disk.bytesPerHour
  const estimate =
    bytesPerHour && bytesPerHour > 0 ? formatBytes((bytesPerHour * durationSec) / 3600) : null

  return (
    <section aria-label={`Recorded clip from ${formatClock(startIso)}`}>
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border bg-[#0b0d12]">
        {/*
          crossOrigin is load-bearing and fails silently without it. The API is
          a separate origin (docs/ARCHITECTURE.md#the-trust-boundary), and a
          <video> sends no cookie cross-origin unless it is asked to - so the
          clip route would answer 401 and the element would show an empty box
          with no error anywhere. "use-credentials" is what carries the session,
          and index.ts already answers with Access-Control-Allow-Credentials.
        */}
        <video
          src={src}
          crossOrigin="use-credentials"
          controls
          autoPlay
          playsInline
          onPlaying={() => setStatus('playing')}
          onError={() => setStatus('error')}
          // contain, not cover: this is a recording somebody may be reading
          // evidence off. Cropping it to fill a 16:9 box would hide part of the
          // frame, which is the opposite of what the page is for.
          className={cn('size-full object-contain', status === 'error' ? 'hidden' : 'block')}
        />

        {/* pointer-events-none, or this strip would swallow clicks meant for
            the native controls underneath it. */}
        {status === 'error' ? null : (
          <div className="pointer-events-none absolute top-3.5 left-4 flex items-center gap-2.5">
            <span className="inline-flex h-[22px] items-center rounded-full border border-white/15 bg-[rgba(8,10,14,0.62)] px-2.5 text-[11px] font-semibold tracking-[0.05em] text-white">
              RECORDED
            </span>
            {/* Burnt into the frame, so a screenshot of this player still says
                which instant it is of. */}
            <span className="font-mono text-xs tabular-nums text-white">
              {formatClockSeconds(startIso)}
            </span>
          </div>
        )}

        {status === 'error' && (
          <p
            role="status"
            className="text-muted-foreground absolute inset-0 flex items-center justify-center p-4 text-center text-xs"
          >
            That footage could not be loaded. It may have passed out of the retention window since
            the timeline was drawn - reload the page.
          </p>
        )}
      </div>

      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>
          {humanDuration(durationSec)} from {formatClock(startIso)}
          {status === 'loading' && ' · loading…'}
        </span>
        {/*
          `download` is honoured only same-origin, and the clip lives on the API
          origin — so this opens the mp4 in a tab rather than saving it, and the
          label says "open" rather than promising otherwise. Making it a true
          download needs Content-Disposition from the clip route, which is an
          API change this redesign deliberately does not make. The alternative,
          fetching the whole window into a blob first, would buffer what
          docs/ARCHITECTURE.md#playback says to stream.
        */}
        <a
          href={src}
          download
          target="_blank"
          rel="noopener"
          className="hover:text-foreground inline-flex items-center gap-1.5 underline underline-offset-2"
        >
          <ExternalLinkIcon className="size-3" aria-hidden />
          Open the raw clip
        </a>
        {estimate ? <span>≈ {estimate}</span> : null}
      </div>
    </section>
  )
}
