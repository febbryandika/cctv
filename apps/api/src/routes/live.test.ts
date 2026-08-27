import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveRoute, parseSessionId } from './live'

// Same three mocks as cameras.test.ts, same reasons: ../auth because
// requireSession imports it and importing it for real opens a postgres pool at
// module load, and ../db because the handler reaches it directly. MediaMTX is
// mocked at the global fetch level here rather than through mediamtx/client,
// because the WHEP proxy speaks SDP and does not go through that JSON client.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../auth', () => ({ auth: { api: { getSession } } }))

const { select, from, where, limit } = vi.hoisted(() => {
  const limit = vi.fn()
  const where = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  return { select, from, where, limit }
})
vi.mock('../db', () => ({ db: { select } }))

const MTX = 'http://127.0.0.1:8889'
const SESSION_ID = '8a91e67a-9192-4a20-a707-9d4354766758'
// Never issued by any test in this file. The ownership map is module-level and
// deliberately outlives a single request, so reusing SESSION_ID here would test
// whichever test happened to run first rather than the guard.
const UNISSUED_ID = '00000000-0000-4000-8000-000000000000'
const ANSWER = 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\n'

const OPERATOR = {
  user: { id: 'u1', email: 'operator@ronda.local', name: 'Operator' },
  session: { id: 's1', userId: 'u1', token: 'tok' },
}
// A second sign-in by the same human is still a different session, which is the
// granularity SPEC 15 asks for ("mapped to the session that created them").
const OTHER = { user: OPERATOR.user, session: { id: 's2', userId: 'u1', token: 'tok2' } }

const signedIn = { headers: { cookie: 'better-auth.session_token=abc' } }
const offer = (body = 'v=0\r\n') => ({
  method: 'POST',
  headers: { ...signedIn.headers, 'content-type': 'application/sdp' },
  body,
})

// Shaped like a real MediaMTX answer: 201, a RELATIVE Location pointing at
// itself, and a literal `*` ETag (observed on v1.20.1).
const mtxCreated = (location: string | null = `/yard_sub/whep/${SESSION_ID}`) =>
  new Response(ANSWER, {
    status: 201,
    headers: {
      'content-type': 'application/sdp',
      ...(location === null ? {} : { location }),
      etag: '*',
    },
  })

const fetchMock = vi.fn()
const app = new Hono().route('/live', liveRoute)

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(OPERATOR)
  select.mockClear()
  from.mockClear()
  where.mockClear()
  limit.mockReset().mockResolvedValue([{ slug: 'yard', enabled: true }])
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(mtxCreated()))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Drives a real POST so the ownership map is populated by the code under test
// rather than by a test-only seam.
async function createSession(as = OPERATOR) {
  getSession.mockResolvedValue(as)
  const res = await app.request('/live/yard/whep', offer())
  expect(res.status).toBe(201)
  return parseSessionId(res.headers.get('location'))
}

describe('POST /live/:slug/whep', () => {
  it('rewrites the Location header to point at us, not MediaMTX', async () => {
    const res = await app.request('/live/yard/whep', offer())

    expect(res.status).toBe(201)
    expect(res.headers.get('location')).toBe(`/live/yard/whep/${SESSION_ID}`)
    expect(await res.text()).toBe(ANSWER)
  })

  // SPEC 9 in one assertion. If any MediaMTX-shaped URL survives into the
  // response, the browser sends PATCH/DELETE to a loopback-bound server, the
  // session check is bypassed, and the stream dies after ~10s in silence.
  it('leaks no MediaMTX address to the browser', async () => {
    const res = await app.request('/live/yard/whep', offer())
    const serialized = JSON.stringify([...res.headers.entries()]) + (await res.text())

    expect(serialized).not.toMatch(/8889/)
    expect(serialized).not.toMatch(/127\.0\.0\.1/)
    expect(serialized).not.toMatch(/rtsp/i)
  })

  it('passes the ETag through', async () => {
    const res = await app.request('/live/yard/whep', offer())
    expect(res.headers.get('etag')).toBe('*')
  })

  // SPEC 7: watching must never disturb the recording, so the recorded path is
  // not merely discouraged — it is unreachable.
  it('asks MediaMTX for the sub-stream, never the recorded path', async () => {
    await app.request('/live/yard/whep', offer())

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${MTX}/yard_sub/whep`)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
    })
  })

  it('forwards the offer body unchanged', async () => {
    await app.request('/live/yard/whep', offer('v=0\r\na=recvonly\r\n'))
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('v=0\r\na=recvonly\r\n')
  })

  it('404s a slug that is not a camera, without calling MediaMTX', async () => {
    limit.mockResolvedValue([])
    const res = await app.request('/live/nope/whep', offer())

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // The path the browser would have to guess to reach the recording.
  it('404s the sub-stream path itself, so it cannot be requested directly', async () => {
    limit.mockResolvedValue([])
    const res = await app.request('/live/yard_sub/whep', offer())

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('404s a disabled camera', async () => {
    limit.mockResolvedValue([{ slug: 'yard', enabled: false }])
    expect((await app.request('/live/yard/whep', offer())).status).toBe(404)
  })

  it('rejects an unauthenticated request and touches nothing', async () => {
    getSession.mockResolvedValue(null)
    const res = await app.request('/live/yard/whep', offer())

    expect(res.status).toBe(401)
    expect(select).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('502s when MediaMTX returns no Location', async () => {
    fetchMock.mockResolvedValue(mtxCreated(null))
    expect((await app.request('/live/yard/whep', offer())).status).toBe(502)
  })

  it('502s when MediaMTX is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await app.request('/live/yard/whep', offer())

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'mediamtx_unreachable' })
  })

  // A sourceOnDemand path MediaMTX cannot pull means the camera is not
  // answering — an operational fact the player renders, not a 500.
  it('503s camera_offline when the sub-stream will not start', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    const res = await app.request('/live/yard/whep', offer())

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'camera_offline' })
  })
})

describe('PATCH /live/:slug/whep/:session', () => {
  const patch = (headers: Record<string, string> = {}) => ({
    method: 'PATCH',
    headers: { ...signedIn.headers, 'content-type': 'application/trickle-ice-sdpfrag', ...headers },
    body: 'a=candidate:1 1 udp 1 127.0.0.1 1 typ host\r\n',
  })

  it('forwards a trickle candidate for a session the caller owns', async () => {
    const id = await createSession()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    const res = await app.request(`/live/yard/whep/${id}`, patch({ 'if-match': '*' }))

    expect(res.status).toBe(204)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${MTX}/yard_sub/whep/${id}`)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'PATCH',
      headers: { 'content-type': 'application/trickle-ice-sdpfrag', 'if-match': '*' },
    })
  })

  it('404s an unknown session id', async () => {
    const res = await app.request(`/live/yard/whep/${UNISSUED_ID}`, patch())

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // SPEC 15: one operator cannot steer another's session by guessing its id.
  it('404s a session owned by a different auth session', async () => {
    const id = await createSession(OPERATOR)
    getSession.mockResolvedValue(OTHER)
    fetchMock.mockClear()

    const res = await app.request(`/live/yard/whep/${id}`, patch())

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('404s when the slug does not match the one the session was created on', async () => {
    const id = await createSession()
    fetchMock.mockClear()

    expect((await app.request(`/live/gate/whep/${id}`, patch())).status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated request', async () => {
    const id = await createSession()
    getSession.mockResolvedValue(null)

    expect((await app.request(`/live/yard/whep/${id}`, patch())).status).toBe(401)
  })
})

describe('DELETE /live/:slug/whep/:session', () => {
  const del = { method: 'DELETE', headers: signedIn.headers }

  it('tears down a session the caller owns', async () => {
    const id = await createSession()
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))

    const res = await app.request(`/live/yard/whep/${id}`, del)

    expect(res.status).toBe(204)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${MTX}/yard_sub/whep/${id}`)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' })
  })

  // The ordinary close path: pc.close() drops ICE, MediaMTX reaps the session,
  // and this DELETE arrives after it is already gone. That is success.
  it('reports success when MediaMTX has already reaped the session', async () => {
    const id = await createSession()
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))

    expect((await app.request(`/live/yard/whep/${id}`, del)).status).toBe(204)
  })

  it('reports success even when MediaMTX is unreachable', async () => {
    const id = await createSession()
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    expect((await app.request(`/live/yard/whep/${id}`, del)).status).toBe(204)
  })

  it('forgets the session, so a second teardown 404s', async () => {
    const id = await createSession()
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    await app.request(`/live/yard/whep/${id}`, del)

    expect((await app.request(`/live/yard/whep/${id}`, del)).status).toBe(404)
  })

  it('404s a session owned by a different auth session', async () => {
    const id = await createSession(OPERATOR)
    getSession.mockResolvedValue(OTHER)
    fetchMock.mockClear()

    const res = await app.request(`/live/yard/whep/${id}`, del)

    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated request', async () => {
    const id = await createSession()
    getSession.mockResolvedValue(null)

    expect((await app.request(`/live/yard/whep/${id}`, del)).status).toBe(401)
  })
})

describe('parseSessionId', () => {
  it('takes the last segment of a relative MediaMTX Location', () => {
    expect(parseSessionId(`/yard_sub/whep/${SESSION_ID}`)).toBe(SESSION_ID)
  })

  it('handles an absolute Location', () => {
    expect(parseSessionId(`${MTX}/yard_sub/whep/${SESSION_ID}`)).toBe(SESSION_ID)
  })

  it('returns null for a missing or unusable header', () => {
    expect(parseSessionId(null)).toBeNull()
    expect(parseSessionId('')).toBeNull()
    expect(parseSessionId('/yard_sub/whep/')).toBeNull()
  })
})
