'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { formatClock, humanDuration } from '@/lib/camera-time'
import { cn } from '@/lib/utils'

// Plays a [start, duration] window served by the clip proxy
// (docs/ARCHITECTURE.md#playback). Deliberately thin: MediaMTX stitches across
// segment boundaries and the proxy asks it for format=mp4, so the moov carries
// a real duration and the browser's own controls do the seeking. A custom
// scrubber would be a second implementation of something that already works.

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

  const startIso = new Date(startMs).toISOString()

  // Built through the typed client rather than by hand, so a rename of the
  // route is a compile error here instead of a 404 at runtime.
  const src = api.recordings[':slug'].clip
    .$url({ param: { slug }, query: { start: startIso, duration: String(durationSec) } })
    .toString()

  return (
    <section className="space-y-2" aria-label={`Recorded clip from ${formatClock(startIso)}`}>
      <div className="bg-muted ring-foreground/10 relative aspect-video overflow-hidden rounded-lg ring-1">
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

      <p className="text-muted-foreground text-xs">
        {humanDuration(durationSec)} from {formatClock(startIso)}
        {status === 'loading' && ' · loading…'}
      </p>
    </section>
  )
}
