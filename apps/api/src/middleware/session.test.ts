import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireSession, type SessionEnv } from './session'

// ../auth is mocked so this test needs no database and no environment:
// importing it for real pulls in ../db, which opens a postgres pool at module
// load. vi.hoisted because vi.mock is hoisted above the const it closes over.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../auth', () => ({ auth: { api: { getSession } } }))

const SESSION = {
  user: { id: 'u1', email: 'operator@ronda.local', name: 'Operator' },
  session: { id: 's1', userId: 'u1', token: 'tok' },
}

const app = new Hono<SessionEnv>().get('/guarded', requireSession, (c) =>
  c.json({ email: c.get('user').email }),
)

describe('requireSession', () => {
  beforeEach(() => {
    getSession.mockReset()
  })

  it('rejects a request with no session', async () => {
    getSession.mockResolvedValue(null)

    const res = await app.request('/guarded')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('accepts a request with a session and exposes the user to the handler', async () => {
    getSession.mockResolvedValue(SESSION)

    const res = await app.request('/guarded', {
      headers: { cookie: 'better-auth.session_token=abc' },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ email: 'operator@ronda.local' })
  })

  it('resolves the session from the request headers', async () => {
    getSession.mockResolvedValue(SESSION)

    await app.request('/guarded', { headers: { cookie: 'better-auth.session_token=abc' } })

    const headers = getSession.mock.calls[0]?.[0]?.headers as Headers
    expect(headers.get('cookie')).toBe('better-auth.session_token=abc')
  })
})
