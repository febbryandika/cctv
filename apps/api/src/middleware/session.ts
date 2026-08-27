import { createMiddleware } from 'hono/factory'
import { auth } from '../auth'

type Session = typeof auth.$Infer.Session

// Every media route resolves the session server-side, and MediaMTX binds to
// loopback only (docs/ARCHITECTURE.md#the-trust-boundary), so this API is the
// sole way to reach a stream — which makes this middleware the whole
// access-control story.
export type SessionEnv = {
  Variables: {
    user: Session['user']
    session: Session['session']
  }
}

export const requireSession = createMiddleware<SessionEnv>(async (c, next) => {
  const resolved = await auth.api.getSession({ headers: c.req.raw.headers })

  if (!resolved) return c.json({ error: 'unauthorized' }, 401)

  c.set('user', resolved.user)
  c.set('session', resolved.session)

  await next()
})
