import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { cameras } from '../db/schema'
import { requireSession, type SessionEnv } from '../middleware/session'

// Loopback, like the control and playback APIs
// (docs/ARCHITECTURE.md#the-trust-boundary). The default must match
// .env.example because `bun test` loads no env file. process.env and global
// fetch, never Bun.*: apps/web pulls this file into its TypeScript program via
// the type-only AppType import and has no @types/bun.
const WEBRTC_URL = process.env.MEDIAMTX_WEBRTC_URL ?? 'http://127.0.0.1:8889'

// Longer than mediamtx/client.ts's 3s. A WHEP POST against a sourceOnDemand
// path also has to dial the camera before it can answer, so the deadline covers
// a cold start, not just a loopback round-trip.
const TIMEOUT_MS = 10_000

// A crashed tab never sends its DELETE, so entries would accumulate for the life
// of the process. MediaMTX reaps the real session on its own once ICE drops;
// this only stops the bookkeeping outliving it.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

type WhepSession = { authSessionId: string; slug: string; createdAt: number }

// Module-level, which is half the reason this API is its own long-lived process
// (docs/ARCHITECTURE.md#why-a-separate-api-server). Deliberately not a table:
// the schema (docs/ARCHITECTURE.md#data) has no place for it and a WHEP session
// is meaningless across a restart.
const whepSessions = new Map<string, WhepSession>()

function sweepExpired(now: number) {
  for (const [id, session] of whepSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) whepSessions.delete(id)
  }
}

// MediaMTX answers with a RELATIVE Location — `/yard_sub/whep/<uuid>` — so the
// id is the last segment. Exported because this is the
// docs/ARCHITECTURE.md#the-whep-proxy bug in one function: forward MediaMTX's
// header unchanged and the browser sends PATCH and DELETE straight to a
// loopback-bound server, bypassing the session check, and the stream dies after
// ~10s with nothing in any log.
export function parseSessionId(location: string | null): string | null {
  const id = location?.split('/').pop()
  return id === undefined || id === '' ? null : id
}

/**
 * Which MediaMTX path live view actually watches.
 *
 * The default is the SUB-stream (docs/ARCHITECTURE.md#the-media-pipeline): low
 * bitrate, H.264, and a separate pull from the camera, so watching can never
 * disturb the recording and the picture plays in any browser.
 *
 * LIVE_SOURCE=main opts into watching the recorded path instead, at full
 * resolution. That is a real trade and it is opt-in for a reason:
 *
 *   - the main stream may be H.265, which needs a hardware decoder — it plays
 *     in Chrome and Safari on a machine that has one and shows nothing on a
 *     machine that does not, where the sub-stream always plays;
 *   - it costs the property this function used to guarantee outright, that no
 *     request shape reaches the recorded path.
 *
 * What it does NOT cost is the recording. `yard` is sourceOnDemand: no, so it
 * is already being pulled around the clock; a WebRTC reader attaches to the
 * stream MediaMTX has open rather than opening a second one, and the recorder
 * writes from the same source either way.
 *
 * Either way the path is derived HERE and never sent by the browser, so the
 * only reachable paths are the ones this function can produce.
 *
 * Read per call rather than at module scope so a test can set it.
 */
export const livePath = (slug: string) =>
  process.env.LIVE_SOURCE === 'main' ? slug : `${slug}_sub`

// The slug indexes a MediaMTX URL, so it is constrained before it is
// interpolated; the cameras lookup below is the real gate.
const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9_-]{1,64}$/) })
const sessionParam = slugParam.extend({ session: z.string().min(1).max(128) })

async function findCamera(slug: string) {
  const [camera] = await db
    .select({ slug: cameras.slug, enabled: cameras.enabled })
    .from(cameras)
    .where(eq(cameras.slug, slug))
    .limit(1)

  return camera?.enabled ? camera : null
}

// A session the caller does not own is reported as absent, not as forbidden —
// otherwise the 403/404 split tells an attacker which ids are live.
function ownedSession(id: string, authSessionId: string, slug: string) {
  const session = whepSessions.get(id)
  if (!session) return null
  if (session.authSessionId !== authSessionId || session.slug !== slug) return null
  return session
}

export const liveRoute = new Hono<SessionEnv>()
  .post('/:slug/whep', requireSession, zValidator('param', slugParam), async (c) => {
    const { slug } = c.req.valid('param')
    if (!(await findCamera(slug))) return c.json({ error: 'unknown camera' }, 404)

    const offer = await c.req.text()

    let upstream: Response
    try {
      upstream = await fetch(`${WEBRTC_URL}/${encodeURIComponent(livePath(slug))}/whep`, {
        method: 'POST',
        headers: { 'content-type': 'application/sdp' },
        body: offer,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      console.error('live: WHEP POST failed -', error)
      return c.json({ error: 'mediamtx_unreachable' }, 502)
    }

    if (!upstream.ok) {
      // MediaMTX 404s a path it cannot pull, which for a sourceOnDemand
      // sub-stream means the camera is not answering. That is an operational
      // fact for the operator to see, not a server error.
      if (upstream.status === 404) return c.json({ error: 'camera_offline' }, 503)
      console.error(`live: WHEP POST responded ${upstream.status}`)
      return c.json({ error: 'whep_rejected' }, 502)
    }

    const session = parseSessionId(upstream.headers.get('location'))
    if (!session) return c.json({ error: 'no session in Location header' }, 502)

    sweepExpired(Date.now())
    whepSessions.set(session, {
      authSessionId: c.get('session').id,
      slug,
      createdAt: Date.now(),
    })

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'content-type': 'application/sdp',
        // Point the browser back at us, not at MediaMTX
        // (docs/ARCHITECTURE.md#the-whep-proxy).
        location: `/live/${slug}/whep/${session}`,
        etag: upstream.headers.get('etag') ?? '',
      },
    })
  })

  .patch('/:slug/whep/:session', requireSession, zValidator('param', sessionParam), async (c) => {
    const { slug, session } = c.req.valid('param')
    if (!ownedSession(session, c.get('session').id, slug)) {
      return c.json({ error: 'unknown whep session' }, 404)
    }

    const ifMatch = c.req.header('if-match')
    const body = await c.req.text()

    try {
      const upstream = await fetch(
        `${WEBRTC_URL}/${encodeURIComponent(livePath(slug))}/whep/${encodeURIComponent(session)}`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/trickle-ice-sdpfrag',
            ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      )
      return new Response(null, { status: upstream.status })
    } catch (error) {
      console.error('live: WHEP PATCH failed -', error)
      return c.json({ error: 'mediamtx_unreachable' }, 502)
    }
  })

  .delete('/:slug/whep/:session', requireSession, zValidator('param', sessionParam), async (c) => {
    const { slug, session } = c.req.valid('param')
    if (!ownedSession(session, c.get('session').id, slug)) {
      return c.json({ error: 'unknown whep session' }, 404)
    }

    // Dropped locally whatever MediaMTX says: the caller is done with it either
    // way, and a retained entry is what lets a stale id be probed later.
    whepSessions.delete(session)

    // Teardown is idempotent, so the upstream result is logged and not
    // returned. Closing a tab drops ICE, and MediaMTX reaps the session on its
    // own the moment that happens — routinely before this DELETE arrives.
    // Forwarding its 404 would make the ordinary path look like a failure, and
    // would be indistinguishable from the 404 the guard above returns for a
    // session the caller does not own.
    try {
      const upstream = await fetch(
        `${WEBRTC_URL}/${encodeURIComponent(livePath(slug))}/whep/${encodeURIComponent(session)}`,
        { method: 'DELETE', signal: AbortSignal.timeout(TIMEOUT_MS) },
      )
      if (!upstream.ok && upstream.status !== 404) {
        console.error(`live: WHEP DELETE responded ${upstream.status}`)
      }
    } catch (error) {
      console.error('live: WHEP DELETE failed -', error)
    }

    return new Response(null, { status: 204 })
  })
