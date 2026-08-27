import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rateLimit } from './rate-limit'
import { requireSession, type SessionEnv } from './session'

// Same reason as session.test.ts: importing ../auth for real pulls in ../db,
// which opens a postgres pool at module load.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../auth', () => ({ auth: { api: { getSession } } }))

const sessionFor = (userId: string) => ({
  user: { id: userId, email: `${userId}@ronda.local`, name: 'Operator' },
  session: { id: `s-${userId}`, userId, token: 'tok' },
})

const signedIn = { headers: { cookie: 'better-auth.session_token=abc' } }

// Composed exactly as the clip route composes it - requireSession first, so the
// limiter always has a user to key on - because that ordering is the thing most
// likely to break and the least likely to be noticed.
const limiter = rateLimit({ limit: 3, windowMs: 60_000 })
const app = new Hono<SessionEnv>().get('/limited', requireSession, limiter, (c) => c.text('ok'))

const call = () => app.request('/limited', signedIn)

describe('rateLimit', () => {
  beforeEach(() => {
    getSession.mockReset().mockResolvedValue(sessionFor('u1'))
    limiter.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets requests up to the limit through', async () => {
    const statuses = [await call(), await call(), await call()].map((res) => res.status)

    expect(statuses).toEqual([200, 200, 200])
  })

  it('rejects the request after the limit with 429', async () => {
    await call()
    await call()
    await call()

    const res = await call()

    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate_limited' })
  })

  it('tells the caller how long to wait', async () => {
    await call()
    await call()
    await call()

    vi.advanceTimersByTime(20_000)
    const res = await call()

    // 60s window opened at the first call, 20s elapsed.
    expect(res.headers.get('retry-after')).toBe('40')
  })

  it('does not run the handler once the limit is reached', async () => {
    const handler = vi.fn((c: { text: (body: string) => Response }) => c.text('ok'))
    const scoped = rateLimit({ limit: 1, windowMs: 60_000 })
    const counted = new Hono<SessionEnv>().get('/limited', requireSession, scoped, handler)

    await counted.request('/limited', signedIn)
    await counted.request('/limited', signedIn)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh window once the old one expires', async () => {
    await call()
    await call()
    await call()
    expect((await call()).status).toBe(429)

    vi.advanceTimersByTime(60_001)

    expect((await call()).status).toBe(200)
  })

  // Fixed window, not sliding: the count resets wholesale rather than ageing
  // out request by request. Pinned so the cheaper implementation is a choice
  // somebody made and not a bug somebody left.
  it('resets the whole count at the window boundary, not per request', async () => {
    await call()
    vi.advanceTimersByTime(59_000)
    await call()
    await call()
    expect((await call()).status).toBe(429)

    vi.advanceTimersByTime(1_001)

    const statuses = [await call(), await call(), await call()].map((res) => res.status)
    expect(statuses).toEqual([200, 200, 200])
  })

  it('counts each user separately', async () => {
    await call()
    await call()
    await call()
    expect((await call()).status).toBe(429)

    getSession.mockResolvedValue(sessionFor('u2'))

    expect((await call()).status).toBe(200)
  })

  it('never counts a request that failed the session guard', async () => {
    getSession.mockResolvedValue(null)

    for (let i = 0; i < 10; i += 1) expect((await call()).status).toBe(401)

    getSession.mockResolvedValue(sessionFor('u1'))

    expect((await call()).status).toBe(200)
  })
})
