import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { camerasRoute, joinStatus } from './cameras'

// Three mocks, one reason each:
//   ../auth            requireSession imports it, and importing it for real
//                      pulls in ../db, which opens a postgres pool at module
//                      load. Same module id as middleware/session.ts's import,
//                      so this one mock covers both importers.
//   ../db              the same pool, reached directly by the handler.
//   ../mediamtx/client no test may depend on a running MediaMTX.
// vi.hoisted because vi.mock is hoisted above the consts it closes over.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../auth', () => ({ auth: { api: { getSession } } }))

const { select, from, orderBy } = vi.hoisted(() => {
  const orderBy = vi.fn()
  const from = vi.fn(() => ({ orderBy }))
  const select = vi.fn(() => ({ from }))
  return { select, from, orderBy }
})
vi.mock('../db', () => ({ db: { select } }))

const { listPaths } = vi.hoisted(() => ({ listPaths: vi.fn() }))
vi.mock('../mediamtx/client', () => ({ listPaths }))

const ROWS = [{ slug: 'yard', name: 'Yard', enabled: true }]
const READY = { name: 'yard', ready: true, readyTime: 1787663581029, tracks: ['H264'], source: null }
const IDLE = { name: 'yard_sub', ready: false, readyTime: null, tracks: [], source: null }

const SESSION = {
  user: { id: 'u1', email: 'operator@ronda.local', name: 'Operator' },
  session: { id: 's1', userId: 'u1', token: 'tok' },
}
const signedIn = { headers: { cookie: 'better-auth.session_token=abc' } }

const app = new Hono().route('/cameras', camerasRoute)

beforeEach(() => {
  getSession.mockReset()
  select.mockClear()
  from.mockClear()
  orderBy.mockReset().mockResolvedValue(ROWS)
  listPaths.mockReset().mockResolvedValue([READY, IDLE])
})

describe('GET /cameras', () => {
  it('rejects an unauthenticated request', async () => {
    getSession.mockResolvedValue(null)

    const res = await app.request('/cameras')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('touches neither the database nor MediaMTX when unauthenticated', async () => {
    getSession.mockResolvedValue(null)

    await app.request('/cameras')

    expect(select).not.toHaveBeenCalled()
    expect(listPaths).not.toHaveBeenCalled()
  })

  it('answers a signed-in request with the camera and its status', async () => {
    getSession.mockResolvedValue(SESSION)

    const res = await app.request('/cameras', signedIn)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      mediamtx: 'up',
      cameras: [
        { slug: 'yard', name: 'Yard', enabled: true, online: true, readyAt: 1787663581029 },
      ],
    })
  })

  // docs/ARCHITECTURE.md#the-trust-boundary: the RTSP path IS
  // md5(ONVIF_PASSWORD), so a leaked stream URL leaks a password hash. Asserted
  // on the serialized body, which is what would actually cross the wire.
  it('never sends an RTSP URL to the browser', async () => {
    getSession.mockResolvedValue(SESSION)

    const body = await (await app.request('/cameras', signedIn)).text()

    expect(body).not.toMatch(/rtsp/i)
  })

  it('still answers when MediaMTX is unreachable', async () => {
    getSession.mockResolvedValue(SESSION)
    listPaths.mockRejectedValue(new Error('mediamtx: unreachable'))

    const res = await app.request('/cameras', signedIn)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mediamtx: 'down' })
  })
})

describe('joinStatus', () => {
  it('reports a path as online only when ready', () => {
    // yard_sub is online:true with a zero-value onlineTime while idle. The
    // control API's `online` is not the signal; `ready` is.
    const result = joinStatus([{ slug: 'yard_sub', name: 'Yard sub', enabled: true }], [IDLE])

    expect(result.cameras[0]?.online).toBe(false)
    expect(result.cameras[0]?.readyAt).toBeNull()
  })

  it('reports every camera offline when the control API could not be asked', () => {
    // The MediaMTX-down case, with no network and no mocking: null in, offline
    // out, and the caller is told which kind of offline this is.
    expect(joinStatus(ROWS, null)).toEqual({
      mediamtx: 'down',
      cameras: [{ slug: 'yard', name: 'Yard', enabled: true, online: false, readyAt: null }],
    })
  })

  it('reports a camera with no MediaMTX path at all as offline', () => {
    expect(joinStatus(ROWS, []).cameras[0]?.online).toBe(false)
  })

  it('keeps a disabled camera in the list rather than hiding it', () => {
    const result = joinStatus([{ slug: 'yard', name: 'Yard', enabled: false }], [READY])

    expect(result.cameras).toHaveLength(1)
    expect(result.cameras[0]?.enabled).toBe(false)
  })
})
