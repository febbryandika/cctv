import { createMiddleware } from 'hono/factory'
import type { SessionEnv } from './session'

// SPEC 15: 30 clip requests per minute per user. A clip request makes MediaMTX
// mux up to an hour of video, so the bound is about work done upstream, not
// about the bytes this process moves.
//
// Module state rather than a table, for the same reason live.ts holds its WHEP
// sessions in a Map: this API is one long-lived process
// (docs/ARCHITECTURE.md#why-a-separate-api-server), and a rate limit that
// survives a restart is neither wanted nor implementable without a round trip
// per request. Unlike whepSessions it needs no sweep - it is keyed by user id,
// so it cannot hold more entries than there are accounts, and this app seeds
// exactly one.
//
// Fixed window, not sliding: the count resets wholesale on the boundary, which
// admits bursts of up to 2x the limit across it. For a bound whose job is to
// stop one operator's stuck retry loop from pinning the recorder, that is the
// right amount of machinery.

type Window = { count: number; resetAt: number }

export function rateLimit({ limit, windowMs }: { limit: number; windowMs: number }) {
  const windows = new Map<string, Window>()

  // Keyed by user, not by session: SPEC 15 says per user, and a limit a second
  // sign-in resets is not a limit.
  //
  // It must run AFTER requireSession - c.get('user') is undefined otherwise -
  // which also means an unauthenticated flood is rejected without ever being
  // counted, so it cannot exhaust a real operator's budget.
  const middleware = createMiddleware<SessionEnv>(async (c, next) => {
    const now = Date.now()
    const key = c.get('user').id

    const open = windows.get(key)
    const window = open && open.resetAt > now ? open : { count: 0, resetAt: now + windowMs }

    window.count += 1
    windows.set(key, window)

    if (window.count > limit) {
      c.header('Retry-After', String(Math.ceil((window.resetAt - now) / 1000)))
      return c.json({ error: 'rate_limited' }, 429)
    }

    await next()
  })

  // The Map is a closure, which is what keeps two limiters independent - but it
  // also puts the counter out of a test's reach. Exposed here rather than by
  // making the store a module global, so production code still cannot clear it.
  return Object.assign(middleware, { reset: () => windows.clear() })
}
