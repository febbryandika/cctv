import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { cameras } from '../db/schema'
import { requireSession, type SessionEnv } from '../middleware/session'

// Loopback, like the control and playback APIs (SPEC 15). The default must match
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
// (SPEC 2.3). Deliberately not a table: SPEC 5 has no place for it and a WHEP
// session is meaningless across a restart.
const whepSessions = new Map<string, WhepSession>()

function sweepExpired(now: number) {
  for (const [id, session] of whepSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) whepSessions.delete(id)
  }
}

// MediaMTX answers with a RELATIVE Location — `/yard_sub/whep/<uuid>` — so the
// id is the last segment. Exported because this is the SPEC 9 bug in one
// function: forward MediaMTX's header unchanged and the browser sends PATCH and
// DELETE straight to a loopback-bound server, bypassing the session check, and
// the stream dies after ~10s with nothing in any log.
export function parseSessionId(location: string | null): string | null {
  const id = location?.split('/').pop()
  return id === undefined || id === '' ? null : id
}

// Live view reads the SUB-stream and only the sub-stream (SPEC 7), so watching
// can never disturb the recording. The suffix is applied here rather than sent
// by the browser: `/live/yard/whep` resolves to `yard_sub`, and there is no
// request shape that reaches the recorded path — `/live/yard_sub/whep` is just
// an unknown camera.
const subPath = (slug: string) => `${slug}_sub`

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
      upstream = await fetch(`${WEBRTC_URL}/${encodeURIComponent(subPath(slug))}/whep`, {
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
        // Point the browser back at us, not at MediaMTX (SPEC 9).
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
        `${WEBRTC_URL}/${encodeURIComponent(subPath(slug))}/whep/${encodeURIComponent(session)}`,
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
        `${WEBRTC_URL}/${encodeURIComponent(subPath(slug))}/whep/${encodeURIComponent(session)}`,
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
