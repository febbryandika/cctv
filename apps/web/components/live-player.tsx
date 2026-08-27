'use client'

import { useEffect, useRef, useState } from 'react'
import { API_URL } from '@/lib/api'
import { cn } from '@/lib/utils'

type Status = 'connecting' | 'live' | 'offline' | 'error'

const MESSAGE: Record<Exclude<Status, 'live'>, string> = {
  connecting: 'Connecting…',
  offline: 'Camera offline. Nothing is publishing the sub-stream.',
  error: 'Live view failed. Reload the page to try again.',
}

// A cap, not a deadline. There is no STUN or TURN here —
// docs/ARCHITECTURE.md#what-this-deliberately-does-not-do cuts remote access
// entirely, so the only candidates are host candidates and gathering finishes
// in milliseconds. Whatever has been gathered by then is what gets sent.
const ICE_GATHER_TIMEOUT_MS = 1_000

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
export function LivePlayer({ slug }: { slug: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<Status>('connecting')

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
    }

    connect().catch((error: unknown) => {
      if (cancelled || abort.signal.aborted) return
      console.error('live: WHEP handshake failed -', error)
      setStatus('error')
    })

    window.addEventListener('pagehide', teardown)

    return () => {
      cancelled = true
      // pagehide, not visibilitychange: switching tabs must not kill the stream
      // when nothing will reconnect it.
      window.removeEventListener('pagehide', teardown)
      teardown()
    }
  }, [slug])

  return (
    <div className="bg-muted ring-foreground/10 relative aspect-video overflow-hidden rounded-lg ring-1">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        aria-label={`Live view of ${slug}`}
        className={cn('size-full object-cover', status === 'live' ? 'block' : 'hidden')}
      />
      {status === 'live' ? null : (
        <p
          role="status"
          className="text-muted-foreground absolute inset-0 flex items-center justify-center p-4 text-center text-xs"
        >
          {MESSAGE[status]}
        </p>
      )}
    </div>
  )
}
