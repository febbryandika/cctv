'use client'

import { ExpandIcon, FilmIcon, TriangleAlertIcon, WifiOffIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { API_URL } from '@/lib/api'
import { formatClockSeconds } from '@/lib/camera-time'
import { isTypingTarget } from '@/lib/keys'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

type Status = 'connecting' | 'live' | 'offline' | 'error'

// A cap, not a deadline. There is no STUN or TURN here —
// docs/ARCHITECTURE.md#what-this-deliberately-does-not-do cuts remote access
// entirely, so the only candidates are host candidates and gathering finishes
// in milliseconds. Whatever has been gathered by then is what gets sent.
const ICE_GATHER_TIMEOUT_MS = 1_000

// Fast enough to look live, slow enough that getStats() is not itself a cost.
const STATS_INTERVAL_MS = 2_000

/**
 * Whether this browser can receive H.265 over WebRTC at all.
 *
 * Asked of the browser rather than assumed: HEVC over WebRTC is gated on a
 * hardware decoder, so the answer differs between two machines running the same
 * Chrome build. If it is false and the handshake failed, the codec is the
 * overwhelmingly likely reason — MediaMTX has nothing to offer a receiver that
 * advertises no H.265, so it rejects the offer and the API forwards a 502.
 */
function canReceiveHevc(): boolean {
  const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs
  return codecs?.some((codec) => /h265|hevc/i.test(codec.mimeType)) ?? false
}

// How long a connected stream may show nothing before that counts as a failure
// rather than as buffering. Generous: a first keyframe on a 15fps camera can be
// a second or two out, and crying wolf here would be worse than the silence.
const FIRST_FRAME_GRACE_MS = 6_000

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()

  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }

    const timer = setTimeout(finish, timeoutMs)
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

/**
 * How far behind live the picture is, in milliseconds, or null if the browser
 * will not say.
 *
 * jitterBufferDelay/jitterBufferEmittedCount is the mean time a frame spent
 * waiting in the receiver's buffer. It is NOT end-to-end latency — it cannot
 * see the camera's own encode delay or the LAN hop, and there is no RTCP sender
 * report here to derive one from. It is labelled "buffer" in the UI for exactly
 * that reason: an honest partial number, not a total dressed up as one.
 */
async function readBufferMs(pc: RTCPeerConnection): Promise<number | null> {
  const report = await pc.getStats()
  let result: number | null = null

  report.forEach((entry) => {
    const stat = entry as RTCInboundRtpStreamStats & {
      jitterBufferDelay?: number
      jitterBufferEmittedCount?: number
    }

    if (stat.type !== 'inbound-rtp' || stat.kind !== 'video') return
    if (!stat.jitterBufferDelay || !stat.jitterBufferEmittedCount) return

    result = Math.round((stat.jitterBufferDelay / stat.jitterBufferEmittedCount) * 1000)
  })

  return result
}

// WHEP against the proxy, never against MediaMTX
// (docs/ARCHITECTURE.md#the-whep-proxy, #the-trust-boundary): the media server
// is loopback-bound and unauthenticated, so the only URL this component may
// ever hold is one on the API.
//
// `slug` is the camera, not the MediaMTX path — the API resolves it to the
// sub-stream itself, so live view cannot be pointed at the recorded path
// (docs/ARCHITECTURE.md#the-media-pipeline).
//
// The offer is sent complete rather than trickled. The WHEP flow describes
// trickle, and the proxy implements PATCH for it, but with host candidates only
// there is nothing to trickle: gathering beats the round-trip, so waiting for
// it costs nothing and removes both the SDP-fragment builder and the ETag
// exchange.
export function LivePlayer({
  slug,
  name,
  onTimeToFirstFrame,
}: {
  slug: string
  name: string
  onTimeToFirstFrame?: (ms: number) => void
}) {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [bufferMs, setBufferMs] = useState<number | null>(null)
  // Read off the element rather than from config. Which MediaMTX path the API
  // resolved to is a server-side decision (LIVE_SOURCE), and duplicating it
  // here would be a label that can disagree with the picture. videoWidth is
  // the picture.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [undecodable, setUndecodable] = useState(false)
  const [hevcLikely, setHevcLikely] = useState(false)

  // The frame's own clock. Same zone and same formatter as the header's — a
  // burnt-in timestamp is what makes a screenshot of this frame evidence rather
  // than a picture (docs/ARCHITECTURE.md#timeline-gaps-and-coverage).
  const now = useNow(1_000)

  // Held in a ref so the connection effect can report through it without taking
  // it as a dependency — that effect must run exactly once per slug, and a
  // caller passing an inline arrow would otherwise tear down and re-establish
  // the WHEP session on every render. Assigned in an effect, not during render.
  const reportRef = useRef(onTimeToFirstFrame)
  useEffect(() => {
    reportRef.current = onTimeToFirstFrame
  }, [onTimeToFirstFrame])

  // Connected but decoding nothing. A browser with no hardware HEVC decoder
  // completes the WHEP handshake, reports the connection as live, and produces
  // either no track at all or a track whose videoWidth stays 0 — so neither the
  // connection state nor an `error` event will ever tell the operator. Only the
  // absence of pixels does, and only after giving the first frame time to
  // arrive.
  useEffect(() => {
    // No reset branch: setting state synchronously in an effect body is a
    // cascading render, and it is unnecessary here because the banner is
    // rendered behind `live &&`. A stale `true` is invisible until the stream
    // is live again, at which point this effect re-runs and re-decides.
    if (status !== 'live') return

    const timer = setTimeout(() => {
      setUndecodable((videoRef.current?.videoWidth ?? 0) === 0)
    }, FIRST_FRAME_GRACE_MS)

    return () => clearTimeout(timer)
  }, [status, size?.w])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
      return
    }
    void shellRef.current?.requestFullscreen().catch(() => {})
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (event.key !== 'f' && event.key !== 'F') return

      event.preventDefault()
      toggleFullscreen()
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [toggleFullscreen])

  useEffect(() => {
    let cancelled = false
    let sessionUrl: string | null = null
    const abort = new AbortController()
    const pc = new RTCPeerConnection()

    const teardown = () => {
      abort.abort()
      // Closing the peer connection drops ICE at once, which is what MediaMTX
      // actually notices; the DELETE is bookkeeping on top of that.
      pc.close()

      if (sessionUrl === null) return
      const url = sessionUrl
      sessionUrl = null
      // keepalive so it outlives the navigation that triggered it. Best effort
      // by nature: a cross-origin DELETE needs a preflight that may not finish
      // during unload, and the session is reaped either way.
      void fetch(url, { method: 'DELETE', credentials: 'include', keepalive: true }).catch(() => {})
    }

    pc.addEventListener('track', (event) => {
      const [stream] = event.streams
      if (videoRef.current && stream) videoRef.current.srcObject = stream
    })

    pc.addEventListener('connectionstatechange', () => {
      if (cancelled) return
      if (pc.connectionState === 'connected') setStatus('live')
      // Reported, not papered over: no reconnect-with-backoff, so a drop stays
      // visible and reloading is the operator's call.
      if (pc.connectionState === 'failed') setStatus('error')
    })

    // Stamped before the POST, so the measurement covers the whole handshake
    // the operator actually waited through — signalling, ICE and the first
    // decoded frame — not just the decode.
    const startedAt = performance.now()

    const connect = async () => {
      pc.addTransceiver('video', { direction: 'recvonly' })
      await pc.setLocalDescription(await pc.createOffer())
      await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS)
      if (cancelled) return

      const offer = pc.localDescription?.sdp
      if (offer === undefined) throw new Error('WHEP: no local description')

      const res = await fetch(`${API_URL}/live/${slug}/whep`, {
        method: 'POST',
        headers: { 'content-type': 'application/sdp' },
        body: offer,
        credentials: 'include',
        signal: abort.signal,
      })

      // Claimed before the cancellation check: if the effect was torn down while
      // this request was in flight, the session still exists upstream and
      // teardown needs a URL to release it.
      const location = res.ok ? res.headers.get('location') : null
      if (location !== null) sessionUrl = new URL(location, API_URL).toString()

      if (cancelled) {
        teardown()
        return
      }

      if (res.status === 503) {
        setStatus('offline')
        return
      }
      if (!res.ok) throw new Error(`WHEP POST responded ${res.status}`)
      if (location === null) {
        // The API rewrites this header; if it is unreadable here the cause is
        // almost always CORS exposeHeaders rather than the proxy
        // (docs/ARCHITECTURE.md#the-whep-proxy).
        throw new Error('WHEP: no readable Location header')
      }

      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })

      // The first DECODED frame, not `loadeddata` where it is available:
      // readyState can reach HAVE_CURRENT_DATA before anything is on screen,
      // and this number is only worth printing if it means what it says.
      const video = videoRef.current
      if (!video) return

      const mark = () => {
        if (!cancelled) reportRef.current?.(Math.round(performance.now() - startedAt))
      }

      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(mark)
      } else {
        video.addEventListener('loadeddata', mark, { once: true })
      }
    }

    connect().catch((error: unknown) => {
      if (cancelled || abort.signal.aborted) return
      console.error('live: WHEP handshake failed -', error)
      // Recorded before the status flips so the error view can name a cause
      // instead of asking the operator to guess.
      setHevcLikely(!canReceiveHevc())
      setStatus('error')
    })

    const stats = setInterval(() => {
      if (pc.connectionState !== 'connected') return
      void readBufferMs(pc).then((ms) => {
        if (!cancelled) setBufferMs(ms)
      })
    }, STATS_INTERVAL_MS)

    window.addEventListener('pagehide', teardown)

    return () => {
      cancelled = true
      clearInterval(stats)
      // pagehide, not visibilitychange: switching tabs must not kill the stream
      // when nothing will reconnect it.
      window.removeEventListener('pagehide', teardown)
      teardown()
    }
  }, [slug])

  const live = status === 'live'

  return (
    <div
      ref={shellRef}
      className="relative min-h-[300px] flex-1 overflow-hidden rounded-xl border bg-[#0b0d12]"
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        aria-label={`Live view of ${name}`}
        onLoadedMetadata={(event) =>
          setSize({ w: event.currentTarget.videoWidth, h: event.currentTarget.videoHeight })
        }
        onResize={(event) =>
          setSize({ w: event.currentTarget.videoWidth, h: event.currentTarget.videoHeight })
        }
        className={cn('size-full object-contain', live ? 'block' : 'hidden')}
      />

      {live && undecodable ? (
        <Overlay>
          <TriangleAlertIcon className="text-destructive size-7" aria-hidden />
          <p className="max-w-[52ch] text-sm leading-relaxed text-white/80">
            The stream is connected but this browser decoded no video.
          </p>
          <p className="max-w-[54ch] text-xs leading-relaxed text-white/50">
            The camera is almost certainly sending H.265, which needs a hardware decoder this
            browser does not have. Set <span className="font-mono">LIVE_SOURCE=sub</span> to watch
            the H.264 sub-stream instead, which plays anywhere.
          </p>
        </Overlay>
      ) : null}

      {status === 'connecting' ? (
        <Overlay>
          <span
            aria-hidden
            className="size-[22px] animate-spin rounded-full border-2 border-white/20 border-t-white"
          />
          <p className="text-[13px] text-white/70">Connecting…</p>
        </Overlay>
      ) : null}

      {status === 'offline' ? (
        <Overlay>
          <WifiOffIcon className="size-[30px] text-white/50" aria-hidden />
          <p className="max-w-[46ch] text-sm leading-relaxed text-white/80">
            Camera offline. Nothing is publishing this stream.
          </p>
          {/* The important half. Live view and recording are separate MediaMTX
              paths, and an operator who only reads the first line may assume
              the recording is fine. */}
          <p className="max-w-[52ch] text-xs leading-relaxed text-white/50">
            The recorded path is failing too, so the timeline will show this stretch as a gap with
            cause <span className="font-mono">camera_down</span> — not as quiet footage.
          </p>
          <Link
            href="/recordings"
            className="mt-0.5 inline-flex h-8 items-center rounded-md border border-white/20 px-3 text-[13px] font-medium text-white hover:bg-white/10"
          >
            Open recordings
          </Link>
        </Overlay>
      ) : null}

      {status === 'error' ? (
        <Overlay>
          <TriangleAlertIcon className="text-destructive size-7" aria-hidden />
          <p className="max-w-[48ch] text-sm leading-relaxed text-white/80">
            Live view failed. The WHEP handshake did not complete — reload to try again.
          </p>
          {hevcLikely ? (
            <p className="max-w-[54ch] text-xs leading-relaxed text-white/50">
              This browser advertises no H.265 receiver, so if the camera&apos;s main stream is
              H.265 there was nothing for it to negotiate. Set{' '}
              <span className="font-mono">LIVE_SOURCE=sub</span> on the API to watch the H.264
              sub-stream, which plays anywhere.
            </p>
          ) : null}
        </Overlay>
      ) : null}

      {/* Top strip. Gradient rather than a solid bar so it reads as an overlay
          on the picture, which is what it is. */}
      <div className="absolute inset-x-0 top-0 flex items-center gap-2.5 bg-gradient-to-b from-[rgba(8,10,14,0.72)] to-transparent px-4 py-3.5">
        {live ? (
          <span className="bg-destructive inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-bold tracking-[0.06em] text-white">
            <span aria-hidden className="animate-status size-1.5 rounded-full bg-white" />
            LIVE
          </span>
        ) : (
          <span className="inline-flex h-6 items-center rounded-full bg-white/15 px-2.5 text-[11px] font-bold tracking-[0.06em] text-white">
            NO SIGNAL
          </span>
        )}
        <span className="text-[13px] font-semibold text-white">{name}</span>
        {/* The measured picture, not the configured one. */}
        <span className="font-mono text-[11px] text-white/60">
          {size && size.w > 0 ? `${size.w}×${size.h} · ` : ''}WebRTC
        </span>
        <div className="ml-auto flex items-center gap-3.5 font-mono text-[11px] tabular-nums text-white/75">
          {live && bufferMs !== null ? <span>buffer {bufferMs} ms</span> : null}
          <span>{now === null ? '--:--:--' : formatClockSeconds(new Date(now).toISOString())}</span>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-[rgba(8,10,14,0.72)] to-transparent px-4 py-3.5">
        <button
          type="button"
          onClick={toggleFullscreen}
          className="inline-flex h-8 items-center gap-[7px] rounded-md border border-white/20 bg-[rgba(8,10,14,0.5)] px-3 text-xs font-medium text-white hover:bg-[rgba(8,10,14,0.8)]"
        >
          <ExpandIcon className="size-3.5" aria-hidden />
          Fullscreen <span className="opacity-60">F</span>
        </button>
        {/* "What just happened?" in one click. The instant is read at click
            time, not during render — a clock in a render body is impure, and
            this one would be stale by the time it was used anyway. */}
        <button
          type="button"
          onClick={() =>
            router.push(`/recordings?at=${new Date(Date.now() - 5 * 60_000).toISOString()}`)
          }
          className="inline-flex h-8 items-center gap-[7px] rounded-md border border-white/20 bg-[rgba(8,10,14,0.5)] px-3 text-xs font-medium text-white hover:bg-[rgba(8,10,14,0.8)]"
        >
          <FilmIcon className="size-3.5" aria-hidden />
          Last 5 minutes
        </button>
        {/* Which path is being RECORDED, beside a picture that is not it. The
            sub-stream is what you are watching; `yard` is what is on disk. */}
        <div className="ml-auto flex h-8 items-center gap-2 rounded-md border border-white/15 bg-[rgba(8,10,14,0.5)] px-3">
          <span aria-hidden className="bg-rec size-[7px] rounded-[2px]" />
          <span className="text-xs whitespace-nowrap text-white">
            Recording <span className="font-mono text-white/65">{slug}</span> · 10-min segments
          </span>
        </div>
      </div>
    </div>
  )
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0d12] p-8 text-center"
    >
      {children}
    </div>
  )
}
