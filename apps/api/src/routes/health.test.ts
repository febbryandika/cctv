import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaMtxError, type MediaMtxPath } from '../mediamtx/client'
import type * as MediaMtxClient from '../mediamtx/client'
import type * as Disk from '../timeline/disk'
import type { Emitted } from '../mediamtx/poller'
import type { Span } from '../timeline/coverage'
import { buildHealth, healthRoute, project, type CameraReading, type HealthBody } from './health'

// Five mocks, one reason each:
//   ../auth              requireSession imports it, and importing it for real
//                        pulls in ../db, which opens a postgres pool at module
//                        load. Same module id as middleware/session.ts's import.
//   ../db                the same pool, reached directly by the handler.
//   ../mediamtx/client   no test may depend on a running MediaMTX.
//   ../timeline/disk     no test may depend on a recordings directory or on how
//                        much space the machine running CI happens to have.
//   ../mediamtx/poller   the SSE route subscribes to it; the mock is what lets a
//                        test emit a transition without a poll cycle.
// importOriginal on the client mock because loadTimespans branches on
// `instanceof MediaMtxError`.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../auth', () => ({ auth: { api: { getSession } } }))

const { select, queue } = vi.hoisted(() => {
  // Same queue-based drizzle stub as routes/recordings.test.ts and
  // poller.test.ts, duplicated rather than shared: this repo has no test-util
  // module and every suite is self-contained. Two read shapes are covered by
  // making every stage thenable - .from().orderBy() for the camera list, and
  // .from().where().orderBy() for the history.
  const queue: unknown[][] = []

  const select = vi.fn(() => {
    const rows = queue.shift() ?? []
    const limit = () => Promise.resolve(rows)
    const orderBy = vi.fn(() => Object.assign(Promise.resolve(rows), { limit }))
    const where = vi.fn(() => Object.assign(Promise.resolve(rows), { orderBy, limit }))
    return { from: vi.fn(() => Object.assign(Promise.resolve(rows), { where, orderBy, limit })) }
  })

  return { select, queue }
})
vi.mock('../db', () => ({ db: { select } }))

const { listPaths, listTimespans } = vi.hoisted(() => ({
  listPaths: vi.fn(),
  listTimespans: vi.fn(),
}))
vi.mock('../mediamtx/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaMtxClient>()),
  listPaths,
  listTimespans,
}))

const { listSegments, diskSpace } = vi.hoisted(() => ({
  listSegments: vi.fn(),
  diskSpace: vi.fn(),
}))
vi.mock('../timeline/disk', async (importOriginal) => ({
  ...(await importOriginal<typeof Disk>()),
  listSegments,
  diskSpace,
}))

const { subscribe, unsubscribe, emit } = vi.hoisted(() => {
  const listeners = new Set<(event: unknown) => void>()
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((listener: (event: unknown) => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      unsubscribe()
    }
  })
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event))
  return { subscribe, unsubscribe, emit, listeners }
})
vi.mock('../mediamtx/poller', () => ({ subscribe }))

// Fixed epoch integers, never new Date('...'): this suite runs under TZ=UTC and
// TZ=Asia/Jakarta and must produce identical output.
const NOW = 1_787_616_000_000 // 2026-08-25T00:00:00Z
const HOUR = 3_600_000
const DAY = 24 * HOUR
const GB = 1_000_000_000

const WINDOW: Span = { start: NOW - DAY, end: NOW }

const READY: MediaMtxPath = {
  name: 'yard',
  ready: true,
  readyTime: NOW - 5 * DAY,
  tracks: ['H264'],
  source: null,
}

const ROWS = [{ slug: 'yard', name: 'Yard', enabled: true }]
const HISTORY = [
  { day: '2026-08-23', coverage: 0.99, gapCount: 1, longestGapSec: 120, bytesWritten: 26 * GB },
  { day: '2026-08-24', coverage: 1, gapCount: 0, longestGapSec: 0, bytesWritten: 27 * GB },
]

// What the database hands back now: one query for every camera, so each row
// carries the slug that the response then strips.
const historyRows = (slug: string, rows = HISTORY) =>
  rows.map((row) => ({ cameraSlug: slug, ...row }))

const SESSION = {
  user: { id: 'u1', email: 'operator@ronda.local', name: 'Operator' },
  session: { id: 's1', userId: 'u1', token: 'tok' },
}
const signedIn = { headers: { cookie: 'better-auth.session_token=abc' } }

const app = new Hono().route('/health', healthRoute)

const reading = (over: Partial<CameraReading> = {}): CameraReading => ({
  slug: 'yard',
  name: 'Yard',
  enabled: true,
  raw: [{ start: WINDOW.start, end: WINDOW.end }],
  segments: [],
  history: [],
  ...over,
})

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(SESSION)
  select.mockClear()
  queue.length = 0
  listPaths.mockReset().mockResolvedValue([READY])
  listTimespans.mockReset().mockResolvedValue([{ start: NOW - DAY, end: NOW }])
  listSegments.mockReset().mockResolvedValue([])
  diskSpace.mockReset().mockResolvedValue({ freeBytes: 120 * GB, totalBytes: 500 * GB })
  subscribe.mockClear()
  unsubscribe.mockClear()
})

describe('project', () => {
  // The number this endpoint exists for. It is MEASURED, never
  // recordDeleteAfter: a retention setting nobody checked against a real
  // bitrate is a guess, and a bitrate that drifted up fills the disk days
  // before the configured window expires.
  it('projects days remaining from bytes actually written', () => {
    expect(project(120 * GB, 24 * GB, DAY)).toEqual({
      bytesPerHour: GB,
      daysRemaining: 5,
    })
  })

  it('scales a sub-day window up to a per-hour rate', () => {
    expect(project(48 * GB, 2 * GB, 2 * HOUR)).toEqual({
      bytesPerHour: GB,
      daysRemaining: 2,
    })
  })

  // null rather than Infinity: "no footage, so no projection" is the honest
  // answer, and Infinity does not survive JSON.stringify - it becomes null
  // anyway, but by accident rather than on purpose.
  it('declines to project when nothing is being written', () => {
    expect(project(120 * GB, 0, DAY)).toEqual({ bytesPerHour: 0, daysRemaining: null })
  })

  it('declines to project when the disk could not be read', () => {
    const projected = project(null, 24 * GB, DAY)

    expect(projected.bytesPerHour).toBe(GB)
    expect(projected.daysRemaining).toBeNull()
  })
})

describe('buildHealth', () => {
  it('reports a healthy camera', () => {
    const body = buildHealth(
      [reading()],
      [READY],
      { freeBytes: 120 * GB, totalBytes: 500 * GB },
      WINDOW,
    )

    expect(body.mediamtx).toBe('up')
    expect(body.checkedAt).toBe('2026-08-25T00:00:00.000Z')
    expect(body.cameras[0]).toMatchObject({
      slug: 'yard',
      online: true,
      coverage24h: 1,
      gapCount: 0,
      longestGapSec: 0,
    })
  })

  it('counts gaps over the tolerance and measures the longest', () => {
    const raw: Span[] = [
      { start: WINDOW.start, end: WINDOW.start + 6 * HOUR },
      { start: WINDOW.start + 7 * HOUR, end: WINDOW.start + 9 * HOUR },
      { start: WINDOW.start + 12 * HOUR, end: WINDOW.end },
    ]

    expect(buildHealth([reading({ raw })], [READY], null, WINDOW).cameras[0]).toMatchObject({
      coverage24h: 1 - 4 / 24,
      gapCount: 2,
      longestGapSec: 3 * 3600,
    })
  })

  // "this camera is down" and "we could not tell" are different facts, and
  // saying which is the entire point of this project. A health page that
  // reported 0% coverage because its own control API was unreachable would
  // invent the outage it exists to detect.
  it('says it could not tell, rather than reporting an outage', () => {
    const body = buildHealth([reading({ raw: null })], null, null, WINDOW)

    expect(body.mediamtx).toBe('down')
    expect(body.cameras[0]).toMatchObject({
      online: false,
      coverage24h: null,
      gapCount: null,
      longestGapSec: null,
    })
  })

  // `ready`, never `online`: MediaMTX reports online: true for an idle
  // on-demand path, so `online` would call a camera that has been down for
  // hours live.
  it('reads ready, and treats a path MediaMTX has forgotten as offline', () => {
    const idle: MediaMtxPath = { ...READY, ready: false }

    expect(buildHealth([reading()], [idle], null, WINDOW).cameras[0]?.online).toBe(false)
    expect(buildHealth([reading()], [], null, WINDOW).cameras[0]?.online).toBe(false)
  })

  // From the filesystem, so it survives a MediaMTX that cannot be reached. The
  // disk does not stop filling because the control API is down.
  it('weighs the disk even when MediaMTX cannot be asked', () => {
    const segments = [
      { mtimeMs: WINDOW.start - HOUR, size: 5 * GB },
      { mtimeMs: WINDOW.start + HOUR, size: 12 * GB },
      { mtimeMs: WINDOW.start + 2 * HOUR, size: 12 * GB },
    ]
    const body = buildHealth(
      [reading({ raw: null, segments })],
      null,
      { freeBytes: 120 * GB, totalBytes: 500 * GB },
      WINDOW,
    )

    expect(body.cameras[0]?.bytesWritten24h).toBe(24 * GB)
    expect(body.disk).toEqual({
      freeBytes: 120 * GB,
      totalBytes: 500 * GB,
      bytesPerHour: GB,
      daysRemaining: 5,
    })
  })

  it('reports the disk as unknown rather than as full', () => {
    const body = buildHealth([reading()], [READY], null, WINDOW)

    expect(body.disk.freeBytes).toBeNull()
    expect(body.disk.totalBytes).toBeNull()
    expect(body.disk.daysRemaining).toBeNull()
  })

  it('passes the stored history straight through, oldest first', () => {
    const body = buildHealth([reading({ history: HISTORY })], [READY], null, WINDOW)

    expect(body.cameras[0]?.history).toEqual(HISTORY)
  })
})

describe('GET /health', () => {
  it('rejects an unauthenticated request', async () => {
    getSession.mockResolvedValue(null)

    const res = await app.request('/health')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('answers with the camera list, the disk and the history', async () => {
    queue.push(ROWS, historyRows('yard'))

    const res = await app.request('/health', signedIn)
    const body = (await res.json()) as HealthBody

    expect(res.status).toBe(200)
    // A cached health page reports how things WERE.
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(body.mediamtx).toBe('up')
    expect(body.cameras).toHaveLength(1)
    expect(body.cameras[0]?.history).toEqual(HISTORY)
    expect(body.disk.freeBytes).toBe(120 * GB)
  })

  // The regression guard for the whole seven-camera change. /health used to do
  // three sequential awaits per camera, one of them a query, so seven cameras
  // meant eight queries and 21 round-trips. The count is asserted, not the
  // latency, because the count is what silently regresses.
  it('reads two cameras with two queries, and gives each its own history', async () => {
    const yardHistory = historyRows('yard')
    const cam2History = historyRows('cam2', [
      { day: '2026-08-24', coverage: 0.5, gapCount: 4, longestGapSec: 900, bytesWritten: 13 * GB },
    ])

    queue.push(
      [
        { slug: 'yard', name: 'Yard', enabled: true },
        { slug: 'cam2', name: 'Camera 2', enabled: true },
      ],
      // One query for both cameras, so both slugs come back interleaved in one
      // row-set rather than as one row-set each.
      [...yardHistory, ...cam2History],
    )

    const res = await app.request('/health', signedIn)
    const body = (await res.json()) as HealthBody

    expect(res.status).toBe(200)
    expect(body.cameras).toHaveLength(2)
    expect(body.cameras[0]?.history).toEqual(HISTORY)
    expect(body.cameras[1]?.history).toEqual([
      { day: '2026-08-24', coverage: 0.5, gapCount: 4, longestGapSec: 900, bytesWritten: 13 * GB },
    ])
    // Two: the camera list, then the history for both. Not one per camera.
    expect(select).toHaveBeenCalledTimes(2)
  })

  // The playback API answers 400 - not 404 - for a path that has never
  // recorded, which is honestly zero coverage rather than a failure to ask.
  it('reads a 400 from the playback API as no footage', async () => {
    queue.push(ROWS, [])
    listTimespans.mockRejectedValue(new MediaMtxError('no recordings', { status: 400 }))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const body = (await (await app.request('/health', signedIn)).json()) as HealthBody

    expect(body.cameras[0]?.coverage24h).toBe(0)
    expect(body.cameras[0]?.gapCount).toBe(1)
    warned.mockRestore()
  })

  it('still answers when MediaMTX is unreachable', async () => {
    queue.push(ROWS, [])
    listPaths.mockRejectedValue(new Error('ECONNREFUSED'))
    listTimespans.mockRejectedValue(new Error('ECONNREFUSED'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/health', signedIn)
    const body = (await res.json()) as HealthBody

    expect(res.status).toBe(200)
    expect(body.mediamtx).toBe('down')
    expect(body.cameras[0]?.coverage24h).toBeNull()
    logged.mockRestore()
  })
})

describe('GET /health/events', () => {
  // Fake timers so the 15s keepalive does not hold a real setTimeout open past
  // the end of the test.
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects an unauthenticated request', async () => {
    getSession.mockResolvedValue(null)

    const res = await app.request('/health/events')

    expect(res.status).toBe(401)
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('opens a stream and pushes transitions as they are recorded', async () => {
    const res = await app.request('/health/events', signedIn)

    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    // One frame straight away, so the headers flush and EventSource fires
    // `open` rather than holding a connection that has produced no bytes.
    expect(decoder.decode((await reader.read()).value)).toContain('event: open')

    const transition: Emitted = { slug: 'yard', kind: 'down', detail: null, at: NOW }
    emit(transition)

    const frame = decoder.decode((await reader.read()).value)
    expect(frame).toContain('event: transition')
    expect(frame).toContain('"slug":"yard"')
    expect(frame).toContain('"kind":"down"')
    // The instant leaves as RFC3339 UTC; camera-local formatting is the
    // browser's job.
    expect(frame).toContain('"at":"2026-08-25T00:00:00.000Z"')

    await reader.cancel()
    await vi.advanceTimersByTimeAsync(20_000)
  })

  // The clean close. A stream whose listener outlived its socket would keep the
  // poller writing into a dead TransformStream for the life of the process.
  it('unsubscribes when the client disconnects', async () => {
    const res = await app.request('/health/events', signedIn)
    const reader = res.body!.getReader()
    await reader.read()

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()

    await reader.cancel()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(unsubscribe).toHaveBeenCalled()
  })

  it('sends a keepalive so an idle connection is not dropped', async () => {
    const res = await app.request('/health/events', signedIn)
    const reader = res.body!.getReader()
    await reader.read()

    const next = reader.read()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(new TextDecoder().decode((await next).value)).toContain('event: ping')

    await reader.cancel()
    await vi.advanceTimersByTimeAsync(20_000)
  })
})
