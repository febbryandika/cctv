import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaMtxError, type MediaMtxPath } from './client'
import type * as MediaMtxClient from './client'

// Two mocks, one reason each:
//   ../db     the poller reads the camera list and writes transitions;
//             importing it for real opens a postgres pool at module load.
//   ./client  no test may depend on a running MediaMTX.
//
// The client mock is a plain factory rather than recordings.test.ts's
// importOriginal spread: that file needs the real MediaMtxError because its
// route branches on `instanceof`, and this poller catches every failure the
// same way. MediaMtxPath is a type and erases.
const { select, queue } = vi.hoisted(() => {
  // The same queue-based stub as routes/recordings.test.ts, duplicated rather
  // than shared: this repo has no test-util module and every suite is
  // self-contained, so twelve copied lines beat a fixture that couples two
  // files. initialise() makes two shapes of read - .from().where() for the
  // camera list and .from().where().orderBy().limit() for the last event - and
  // one stub covers both by making every stage thenable.
  const queue: unknown[][] = []

  const select = vi.fn(() => {
    const rows = queue.shift() ?? []
    const tail = Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) })
    const where = vi.fn(() =>
      Object.assign(Promise.resolve(rows), {
        limit: () => Promise.resolve(rows),
        orderBy: () => tail,
      }),
    )
    return { from: vi.fn(() => ({ where })) }
  })

  return { select, queue }
})

const { insert, inserted, fail } = vi.hoisted(() => {
  const inserted: Record<string, unknown>[] = []
  // A mutable box rather than a queue: exactly one test needs a failed write,
  // and a queue that must be drained in the right order is a second thing to
  // get wrong.
  const fail = { next: false }

  const insert = vi.fn(() => ({
    values: vi.fn((row: Record<string, unknown>) => {
      if (fail.next) {
        fail.next = false
        return Promise.reject(new Error('insert failed'))
      }
      inserted.push(row)
      return Promise.resolve([])
    }),
  }))

  return { insert, inserted, fail }
})
vi.mock('../db', () => ({ db: { select, insert } }))

const { listPaths } = vi.hoisted(() => ({ listPaths: vi.fn() }))
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaMtxClient>()),
  listPaths,
}))

// Integer literals, never new Date('...'): the suite runs under both TZ=UTC and
// TZ=Asia/Jakarta and must produce identical output.
const NOW = 1787884259000 // 2026-08-28T02:30:59Z

const path = (name: string, ready: boolean): MediaMtxPath => ({
  name,
  ready,
  readyTime: ready ? NOW - 60_000 : null,
  tracks: ready ? ['H264'] : [],
  source: null,
})

const YARD_UP = path('yard', true)
const YARD_DOWN = path('yard', false)
// sourceOnDemand: yes, so it is legitimately not-ready whenever nobody is
// watching. It has no row in `cameras`.
const SUB_IDLE = path('yard_sub', false)

// initialise() reads the camera list, then one last-event row per camera.
const primeInit = (slugs: string[], lastKinds: (('up' | 'down') | null)[]) => {
  queue.push(slugs.map((slug) => ({ slug })))
  for (const kind of lastKinds) queue.push(kind ? [{ kind }] : [])
}

// The module keeps last-known state in a module-level Map, so each test needs a
// fresh copy of the module. resetModules() rather than an exported reset:
// rate-limit.ts exposes reset() because its store is a CLOSURE a test cannot
// otherwise reach, and explicitly so "production code still cannot clear it".
// A module global is already reachable this way, so shipping an affordance
// would be the opposite of that precedent. Hoisted mocks keep their identity
// across the reload.
const load = () => import('./poller')

let errorSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetModules()
  queue.length = 0
  inserted.length = 0
  fail.next = false
  select.mockClear()
  insert.mockClear()
  listPaths.mockReset().mockResolvedValue([YARD_UP, SUB_IDLE])
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  errorSpy.mockRestore()
  logSpy.mockRestore()
  vi.unstubAllEnvs()
})

describe('transitions', () => {
  const KNOWN_UP = new Map([['yard', 'up' as const]])
  const KNOWN_DOWN = new Map([['yard', 'down' as const]])

  it('emits nothing when a known-up camera is still ready', async () => {
    const { transitions } = await load()

    expect(transitions(KNOWN_UP, [YARD_UP])).toEqual([])
  })

  it('emits nothing when a known-down camera is still not ready', async () => {
    const { transitions } = await load()

    expect(transitions(KNOWN_DOWN, [YARD_DOWN])).toEqual([])
  })

  it('emits a down when a known-up camera stops being ready', async () => {
    const { transitions } = await load()

    expect(transitions(KNOWN_UP, [YARD_DOWN])).toEqual([
      { slug: 'yard', kind: 'down', detail: null },
    ])
  })

  it('emits an up when a known-down camera becomes ready', async () => {
    const { transitions } = await load()

    expect(transitions(KNOWN_DOWN, [YARD_UP])).toEqual([{ slug: 'yard', kind: 'up', detail: null }])
  })

  it('treats a camera absent from the path list as down, and says so', async () => {
    const { transitions } = await load()

    expect(transitions(KNOWN_UP, [])).toEqual([
      { slug: 'yard', kind: 'down', detail: 'path not present in mediamtx' },
    ])
  })

  // The highest-value case here. stream_events.cameraSlug references
  // cameras.slug, and yard_sub has no row - so a poller that iterated the path
  // list instead of the known map would attempt a foreign-key violation every
  // ten seconds, forever, every time somebody opened the live view.
  it('ignores MediaMTX paths that are not cameras', async () => {
    const { transitions } = await load()

    expect(transitions(KNOWN_UP, [YARD_UP, SUB_IDLE])).toEqual([])
    expect(transitions(new Map(), [SUB_IDLE, path('yard_sub', true)])).toEqual([])
  })

  it('reads ready, not online, for a path that is up but idle', async () => {
    const { transitions } = await load()

    // A MediaMTX payload where `online` would say true and `ready` says false.
    // `online` is absent from the schema, so the only signal here is `ready`.
    expect(transitions(KNOWN_UP, [{ ...YARD_DOWN, readyTime: NOW - 3_600_000 }])).toEqual([
      { slug: 'yard', kind: 'down', detail: null },
    ])
  })

  it('emits one entry per changed camera and skips the unchanged one', async () => {
    const { transitions } = await load()
    const known = new Map([
      ['yard', 'up' as const],
      ['gate', 'down' as const],
      ['door', 'up' as const],
    ])

    expect(transitions(known, [YARD_DOWN, path('gate', true), path('door', true)])).toEqual([
      { slug: 'yard', kind: 'down', detail: null },
      { slug: 'gate', kind: 'up', detail: null },
    ])
  })

  it('does not mutate the map it is given', async () => {
    const { transitions } = await load()
    const known = new Map([['yard', 'up' as const]])

    transitions(known, [YARD_DOWN])

    expect(known.get('yard')).toBe('up')
  })
})

describe('pollOnce', () => {
  it('writes exactly one row for a down transition, stamped at the detection instant', async () => {
    primeInit(['yard'], ['up'])
    listPaths.mockResolvedValue([YARD_DOWN, SUB_IDLE])
    const { pollOnce } = await load()

    await pollOnce()

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ cameraSlug: 'yard', kind: 'down', detail: null })
    // The detection instant, never readyTime: inferCause() matches a `down`
    // only inside [gap.start, gap.end), and a backdated one lands before the
    // gap begins and silently reads `unknown`.
    expect((inserted[0]?.at as Date).getTime()).toBe(NOW)
  })

  // M7 in the mutation pass: backdating `at` to the path's readyTime survived
  // every other assertion, because a not-ready path usually reports null. These
  // two pin the rule from both sides, because readyTime is the single most
  // tempting "improvement" a later reader will propose - and inferCause() only
  // matches a `down` inside [gap.start, gap.end), so a backdated one reads
  // `unknown` with nothing wrong in any log.
  it('stamps an up at the detection instant, not at readyTime', async () => {
    primeInit(['yard'], ['down'])
    // Ready for an hour already; the transition is only now being observed.
    listPaths.mockResolvedValue([{ ...YARD_UP, readyTime: NOW - 3_600_000 }])
    const { pollOnce } = await load()

    await pollOnce()

    expect((inserted[0]?.at as Date).getTime()).toBe(NOW)
  })

  it('stamps a down at the detection instant, not at a stale readyTime', async () => {
    primeInit(['yard'], ['up'])
    // MediaMTX keeps reporting the last time the path WAS ready, which is
    // before the gap this down explains.
    listPaths.mockResolvedValue([{ ...YARD_DOWN, readyTime: NOW - 600_000 }])
    const { pollOnce } = await load()

    await pollOnce()

    expect((inserted[0]?.at as Date).getTime()).toBe(NOW)
  })

  it('writes nothing when the state has not changed', async () => {
    primeInit(['yard'], ['up'])
    const { pollOnce } = await load()

    await pollOnce()

    expect(inserted).toHaveLength(0)
  })

  // The assertion this build-order step is defined by.
  it('writes exactly one row per change, not one per poll', async () => {
    primeInit(['yard'], ['up'])
    listPaths.mockResolvedValue([YARD_DOWN, SUB_IDLE])
    const { pollOnce } = await load()

    await pollOnce()
    await pollOnce()
    await pollOnce()

    expect(inserted).toHaveLength(1)
  })

  it('writes down, up and down again across a flap', async () => {
    primeInit(['yard'], ['up'])
    const { pollOnce } = await load()

    listPaths.mockResolvedValue([YARD_DOWN])
    await pollOnce()
    listPaths.mockResolvedValue([YARD_UP])
    await pollOnce()
    listPaths.mockResolvedValue([YARD_DOWN])
    await pollOnce()

    expect(inserted.map((row) => row.kind)).toEqual(['down', 'up', 'down'])
  })

  // Build order step 9, task 3: a restart must not manufacture a transition.
  it('writes nothing when a restart finds the camera as the table left it', async () => {
    primeInit(['yard'], ['down'])
    listPaths.mockResolvedValue([YARD_DOWN, SUB_IDLE])
    const { pollOnce } = await load()

    await pollOnce()

    expect(inserted).toHaveLength(0)
  })

  it('writes nothing on a fresh table when the camera is already up', async () => {
    primeInit(['yard'], [null])
    const { pollOnce } = await load()

    await pollOnce()

    expect(inserted).toHaveLength(0)
  })

  it('writes one down on a fresh table when the camera is already down', async () => {
    primeInit(['yard'], [null])
    listPaths.mockResolvedValue([YARD_DOWN])
    const { pollOnce } = await load()

    await pollOnce()

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ kind: 'down' })
  })

  it('skips disabled cameras entirely', async () => {
    // initialise() filters on enabled, so a disabled camera never reaches the
    // known map and cannot produce a row.
    primeInit([], [])
    listPaths.mockResolvedValue([YARD_DOWN])
    const { pollOnce } = await load()

    await pollOnce()

    expect(inserted).toHaveLength(0)
  })

  it('does not treat an unreachable control API as a camera going down', async () => {
    primeInit(['yard'], ['up'])
    listPaths.mockRejectedValue(new MediaMtxError('unreachable'))
    const { pollOnce } = await load()

    await expect(pollOnce()).resolves.toBeUndefined()

    expect(inserted).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()
  })

  // The half that proves in-memory state survived the failure.
  it('still records the transition on the poll after MediaMTX comes back', async () => {
    primeInit(['yard'], ['up'])
    listPaths.mockRejectedValueOnce(new MediaMtxError('unreachable'))
    listPaths.mockResolvedValue([YARD_DOWN])
    const { pollOnce } = await load()

    await pollOnce()
    await pollOnce()

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ kind: 'down' })
  })

  it('retries a failed insert on the next poll with a later timestamp', async () => {
    primeInit(['yard'], ['up'])
    listPaths.mockResolvedValue([YARD_DOWN])
    fail.next = true
    const { pollOnce } = await load()

    await expect(pollOnce()).resolves.toBeUndefined()
    expect(inserted).toHaveLength(0)

    vi.setSystemTime(NOW + 10_000)
    await pollOnce()

    expect(inserted).toHaveLength(1)
    expect((inserted[0]?.at as Date).getTime()).toBe(NOW + 10_000)
  })

  it('survives a startup read failure and initialises on the next poll', async () => {
    select.mockImplementationOnce(() => {
      throw new Error('postgres not ready')
    })
    const { pollOnce } = await load()

    await expect(pollOnce()).resolves.toBeUndefined()
    expect(inserted).toHaveLength(0)

    primeInit(['yard'], ['up'])
    listPaths.mockResolvedValue([YARD_DOWN])
    await pollOnce()

    expect(inserted).toHaveLength(1)
  })

  it('stamps every transition in one poll with the same instant', async () => {
    primeInit(['yard', 'gate'], ['up', 'up'])
    listPaths.mockResolvedValue([YARD_DOWN, path('gate', false)])
    const { pollOnce } = await load()

    await pollOnce()

    expect(inserted).toHaveLength(2)
    expect((inserted[0]?.at as Date).getTime()).toBe((inserted[1]?.at as Date).getTime())
  })

  it('records the surviving camera when another write fails', async () => {
    primeInit(['yard', 'gate'], ['up', 'up'])
    listPaths.mockResolvedValue([YARD_DOWN, path('gate', false)])
    fail.next = true
    const { pollOnce } = await load()

    await pollOnce()

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ cameraSlug: 'gate' })
  })

  // Two ticks overlapping is not hypothetical: a cold Neon compute plus
  // listPaths()'s 3s timeout can push one poll past the 10s interval, and
  // stream_events has no unique constraint to catch the duplicate row.
  it('does not run twice concurrently', async () => {
    primeInit(['yard'], ['up'])
    listPaths.mockResolvedValue([YARD_DOWN])
    const { pollOnce } = await load()

    await Promise.all([pollOnce(), pollOnce()])

    expect(inserted).toHaveLength(1)
    // The camera list plus one last-event read, once - not twice.
    expect(select).toHaveBeenCalledTimes(2)
  })
})

describe('startPoller', () => {
  it('does nothing while VITEST is set', async () => {
    const { startPoller } = await load()

    startPoller()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(listPaths).not.toHaveBeenCalled()
  })

  it('polls immediately and then on the interval, and ignores a second start', async () => {
    vi.stubEnv('VITEST', '')
    primeInit(['yard'], ['up'])
    const { startPoller } = await load()

    startPoller()
    startPoller()
    await vi.advanceTimersByTimeAsync(0)
    expect(listPaths).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)

    // Two, not three: the second startPoller() did not open a second interval.
    expect(listPaths).toHaveBeenCalledTimes(2)
  })
})
