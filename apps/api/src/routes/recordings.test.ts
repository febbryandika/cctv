import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaMtxError } from '../mediamtx/client'
import type * as MediaMtxClient from '../mediamtx/client'
import { TOLERANCE_MS, type Span, type StreamEvent } from '../timeline/coverage'
import { buildTimeline, clipRateLimit, recordingsRoute } from './recordings'

// Same three mocks and the same reasons as cameras.test.ts, with one
// difference: the MediaMTX client is spread from the real module rather than
// replaced wholesale, because the route branches on `instanceof MediaMtxError`
// and a factory-built stub would neither export the class nor share its
// identity. client.ts only reads process.env at module load, so importing it
// for real costs nothing and opens no socket.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../auth', () => ({ auth: { api: { getSession } } }))

const { listTimespans } = vi.hoisted(() => ({ listTimespans: vi.fn() }))
vi.mock('../mediamtx/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaMtxClient>()),
  listTimespans,
}))

// The handler makes three reads with three different chain endings - the camera
// lookup ends in .limit(), the in-window events end in .orderBy(), the
// carry-forward event ends in .orderBy().limit(). Rather than three separate
// stubs, `where` returns a thenable carrying both methods, which is the shape
// drizzle's own builder has. `queue` feeds one row set per select() call, in
// call order.
const { select, queue } = vi.hoisted(() => {
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
vi.mock('../db', () => ({ db: { select } }))

// 2026-08-25T00:00:00+07:00 is 2026-08-24T17:00:00Z - the same Jakarta calendar
// day coverage.test.ts anchors on, so the two files describe the same instants.
// Written as integer literals and never as new Date('...'): a fixture parsed in
// the zone it is read in agrees with the timezone bug instead of catching it,
// and this suite runs under both TZ=UTC and TZ=Asia/Jakarta.
const DAY_START = 1787590800000
const DAY_END = 1787677200000

const SECOND = 1_000
const MINUTE = 60_000
const HOUR = 3_600_000

const DAY: Span = { start: DAY_START, end: DAY_END }

// An hour past the window's end, so the day is entirely settled and nothing
// clamps unless a test asks for it.
const SETTLED = DAY_END + HOUR

const CAMERA = [{ slug: 'yard', enabled: true }]

const SESSION = {
  user: { id: 'u1', email: 'operator@ronda.local', name: 'Operator' },
  session: { id: 's1', userId: 'u1', token: 'tok' },
}
const signedIn = { headers: { cookie: 'better-auth.session_token=abc' } }

const app = new Hono().route('/recordings', recordingsRoute)

const url = (from: string, to: string, slug = 'yard') =>
  `/recordings/${slug}/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`

// The window above, as the browser would send it: RFC3339 with an offset.
const FROM = '2026-08-25T00:00:00+07:00'
const TO = '2026-08-26T00:00:00+07:00'

let nowSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(SESSION)
  select.mockClear()
  listTimespans.mockReset().mockResolvedValue([])
  queue.length = 0
  // camera lookup, in-window events, carry-forward event
  queue.push(CAMERA, [], [])
  nowSpy = vi.spyOn(Date, 'now').mockReturnValue(SETTLED)
})

afterEach(() => {
  nowSpy.mockRestore()
})

describe('buildTimeline', () => {
  it('reports an empty recorder as zero coverage and one window-length gap', () => {
    const body = buildTimeline([], [], DAY, SETTLED)

    expect(body.spans).toEqual([])
    expect(body.coverage).toBe(0)
    expect(body.gaps).toEqual([
      {
        start: '2026-08-24T17:00:00.000Z',
        end: '2026-08-25T17:00:00.000Z',
        durationSec: 86400,
        cause: 'unknown',
      },
    ])
    expect(body.clamped).toBeUndefined()
  })

  it('reports a fully covered window as exactly 1 with no gaps', () => {
    const body = buildTimeline([DAY], [], DAY, SETTLED)

    expect(body.coverage).toBe(1)
    expect(body.gaps).toEqual([])
    expect(body.spans).toEqual([
      {
        start: '2026-08-24T17:00:00.000Z',
        end: '2026-08-25T17:00:00.000Z',
        durationSec: 86400,
      },
    ])
  })

  it('clips a span that started before the window and ends after it', () => {
    // Yesterday 22:00 through tomorrow 02:00, reported as one run. Unclipped
    // this overflows the bar the browser draws.
    const body = buildTimeline(
      [{ start: DAY_START - 2 * HOUR, end: DAY_END + 2 * HOUR }],
      [],
      DAY,
      SETTLED + 3 * HOUR,
    )

    expect(body.spans).toEqual([
      { start: '2026-08-24T17:00:00.000Z', end: '2026-08-25T17:00:00.000Z', durationSec: 86400 },
    ])
    expect(body.coverage).toBe(1)
  })

  // The property that catches any future divergence between this file's clip
  // predicate and the one gaps() applies internally. If they ever disagree the
  // bar develops either an overlap or an unaccounted hole, and neither is
  // visible in a single-interval assertion.
  it('tiles the window with spans and gaps - no overlap, no hole', () => {
    const raw: Span[] = [
      { start: DAY_START - HOUR, end: DAY_START + 90 * MINUTE },
      { start: DAY_START + 3 * HOUR, end: DAY_START + 3 * HOUR + 20 * SECOND },
      { start: DAY_START + 5 * HOUR, end: DAY_START + 11 * HOUR },
      { start: DAY_START + 11 * HOUR + SECOND, end: DAY_END - 30 * MINUTE },
    ]

    const body = buildTimeline(raw, [], DAY, SETTLED)

    const intervals = [...body.spans, ...body.gaps]
      .map((i) => ({ start: Date.parse(i.start), end: Date.parse(i.end) }))
      .sort((a, b) => a.start - b.start)

    expect(intervals.length).toBeGreaterThan(1)
    expect(intervals[0]?.start).toBe(DAY_START)
    expect(intervals.at(-1)?.end).toBe(DAY_END)

    for (const [i, interval] of intervals.entries()) {
      if (i === 0) continue
      expect(interval.start).toBe(intervals[i - 1]?.end)
    }

    // And the two views agree on the arithmetic.
    const recorded = body.spans.reduce((n, s) => n + (Date.parse(s.end) - Date.parse(s.start)), 0)
    expect(body.coverage).toBeCloseTo(recorded / (DAY_END - DAY_START), 12)
  })

  it('merges two spans exactly TOLERANCE_MS apart rather than reporting a gap', () => {
    const body = buildTimeline(
      [
        { start: DAY_START, end: DAY_START + HOUR },
        { start: DAY_START + HOUR + TOLERANCE_MS, end: DAY_END },
      ],
      [],
      DAY,
      SETTLED,
    )

    expect(body.spans).toHaveLength(1)
    expect(body.gaps).toEqual([])
  })

  // docs/ARCHITECTURE.md item 2, at the window edge rather than between spans.
  // gaps() applies TOLERANCE_MS only BETWEEN spans, so without the filter this
  // opens the day with a durationSec: 0 hole.
  it('suppresses a sub-tolerance gap at the window edge', () => {
    const body = buildTimeline([{ start: DAY_START + 300, end: DAY_END }], [], DAY, SETTLED)

    expect(body.gaps).toEqual([])
    // Coverage stays exact rather than being rounded up to match.
    expect(body.coverage).toBeLessThan(1)
    expect(body.coverage).toBeGreaterThan(0.9999)
  })

  // At, just under, and just over - the three points CLAUDE.md names, applied
  // to the window edge where gaps() does not apply the tolerance itself. Exactly
  // TOLERANCE_MS is suppressed because that is what merge() does with the same
  // separation between two spans: the two must not disagree about what counts
  // as a hole.
  it('suppresses a leading gap of exactly the tolerance', () => {
    const body = buildTimeline(
      [{ start: DAY_START + TOLERANCE_MS, end: DAY_END }],
      [],
      DAY,
      SETTLED,
    )

    expect(body.gaps).toEqual([])
  })

  it('keeps a leading gap one millisecond over the tolerance', () => {
    const body = buildTimeline(
      [{ start: DAY_START + TOLERANCE_MS + 1, end: DAY_END }],
      [],
      DAY,
      SETTLED,
    )

    expect(body.gaps).toHaveLength(1)
    expect(body.gaps[0]?.start).toBe('2026-08-24T17:00:00.000Z')
  })

  it('keeps a gap just over the tolerance', () => {
    const body = buildTimeline(
      [
        { start: DAY_START, end: DAY_START + HOUR },
        { start: DAY_START + HOUR + TOLERANCE_MS + 1, end: DAY_END },
      ],
      [],
      DAY,
      SETTLED,
    )

    expect(body.gaps).toHaveLength(1)
  })

  describe('the open span', () => {
    // Half the day recorded, MediaMTX still reporting a duration for the
    // segment it is writing and overshooting the present by six minutes.
    const NOON = DAY_START + 12 * HOUR
    const OPEN: Span = { start: DAY_START, end: NOON + 6 * MINUTE }

    it('stops the window and the span at now, not at the requested end', () => {
      const body = buildTimeline([OPEN], [], DAY, NOON)

      expect(body.window.to).toBe(new Date(NOON).toISOString())
      expect(body.spans.at(-1)?.end).toBe(new Date(NOON).toISOString())
      // The whole elapsed part of the day is covered, and the hours that have
      // not happened are not a gap.
      expect(body.coverage).toBe(1)
      expect(body.gaps).toEqual([])
    })

    it('does not let an overshooting open span inflate coverage', () => {
      // Six hours recorded out of the twelve that have elapsed, with MediaMTX
      // claiming the run continues six minutes into the future. The answer must
      // be half the elapsed day - not more, and not half of the whole day.
      const body = buildTimeline(
        [
          { start: DAY_START, end: DAY_START + 3 * HOUR },
          { start: NOON - 3 * HOUR, end: NOON + 6 * MINUTE },
        ],
        [],
        DAY,
        NOON,
      )

      expect(body.coverage).toBe(0.5)
      expect(body.spans.at(-1)?.end).toBe(new Date(NOON).toISOString())
    })

    it('surfaces the overshoot rather than swallowing it', () => {
      const body = buildTimeline([OPEN], [], DAY, NOON)

      expect(body.clamped).toEqual({ spanCount: 1, excessSec: 360 })
    })

    it('stays silent when the overshoot is inside the tolerance', () => {
      // 200ms past now, which is where the open segment sits on essentially
      // every request. A `clamped` announcing no discrepancy is noise.
      const body = buildTimeline([{ start: DAY_START, end: NOON + 200 }], [], DAY, NOON)

      expect(body.clamped).toBeUndefined()
    })

    it('stays silent for a settled window, however far the recorder overshoots', () => {
      // Viewing last Tuesday. A span running from inside that day through to
      // beyond the present overshoots by hours, but none of it is inside the
      // window and reporting it there is a false alarm on a settled view.
      const body = buildTimeline([{ start: DAY_START, end: SETTLED + 4 * HOUR }], [], DAY, SETTLED)

      expect(body.clamped).toBeUndefined()
      expect(body.window.to).toBe('2026-08-25T17:00:00.000Z')
    })

    it('counts merged spans, not raw timespans', () => {
      // Two segments of one run, both reported past now. They merge into one
      // span, so the count must be 1 - it names the same population as `spans`.
      const body = buildTimeline(
        [
          { start: DAY_START, end: NOON + 5 * MINUTE },
          { start: DAY_START + HOUR, end: NOON + 6 * MINUTE },
        ],
        [],
        DAY,
        NOON,
      )

      expect(body.clamped?.spanCount).toBe(1)
    })
  })

  describe('gap causes', () => {
    const raw: Span[] = [
      { start: DAY_START, end: DAY_START + 6 * HOUR },
      { start: DAY_START + 7 * HOUR, end: DAY_END },
    ]
    const GAP_START = DAY_START + 6 * HOUR

    it('labels a gap containing a down event', () => {
      const events: StreamEvent[] = [{ kind: 'down', at: GAP_START + MINUTE }]

      expect(buildTimeline(raw, events, DAY, SETTLED).gaps[0]?.cause).toBe('camera_down')
    })

    it('leaves a gap with no matching event unknown', () => {
      // SPEC 4.4: unknown is the interesting one. Inventing a cause here is the
      // dishonesty the module exists to prevent.
      expect(buildTimeline(raw, [], DAY, SETTLED).gaps[0]?.cause).toBe('unknown')
    })

    it('treats a down at the gap end as belonging to the next span', () => {
      // Spans are half-open [start, end) and so are gaps.
      const events: StreamEvent[] = [{ kind: 'down', at: DAY_START + 7 * HOUR }]

      expect(buildTimeline(raw, events, DAY, SETTLED).gaps[0]?.cause).toBe('unknown')
    })

    it('labels an all-window gap from a down carried forward to the window start', () => {
      // What loadEvents synthesises when the last transition before the window
      // was a `down`: the camera was already down when the day opened, and the
      // gap therefore contains no event of its own.
      const events: StreamEvent[] = [{ kind: 'down', at: DAY_START }]

      expect(buildTimeline([], events, DAY, SETTLED).gaps[0]?.cause).toBe('camera_down')
    })
  })

  it('emits every timestamp as RFC3339 UTC that round-trips exactly', () => {
    const body = buildTimeline(
      [{ start: DAY_START + HOUR, end: DAY_START + 2 * HOUR }],
      [],
      DAY,
      SETTLED,
    )

    const stamps = [
      body.window.from,
      body.window.to,
      ...body.spans.flatMap((s) => [s.start, s.end]),
      ...body.gaps.flatMap((g) => [g.start, g.end]),
    ]

    expect(stamps.length).toBeGreaterThan(4)
    for (const stamp of stamps) {
      expect(stamp).toMatch(/Z$/)
      expect(new Date(Date.parse(stamp)).toISOString()).toBe(stamp)
    }

    expect(body.spans[0]?.start).toBe('2026-08-24T18:00:00.000Z')
  })

  it('rounds durationSec to whole seconds', () => {
    const body = buildTimeline(
      [{ start: DAY_START, end: DAY_START + 1370 * SECOND + 600 }],
      [],
      DAY,
      SETTLED,
    )

    expect(body.spans[0]?.durationSec).toBe(1371)
  })

  it('never calls the clock itself', () => {
    // `now` is a parameter so the clamp is testable at a fixed instant. A
    // Date.now() in here would make every assertion above time-dependent.
    nowSpy.mockClear()
    buildTimeline([DAY], [], DAY, SETTLED)
    expect(nowSpy).not.toHaveBeenCalled()
  })
})

describe('GET /recordings/:slug/timeline', () => {
  it('rejects an unauthenticated request', async () => {
    getSession.mockResolvedValue(null)

    const res = await app.request(url(FROM, TO))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('touches neither the database nor MediaMTX when unauthenticated', async () => {
    getSession.mockResolvedValue(null)

    await app.request(url(FROM, TO))

    expect(select).not.toHaveBeenCalled()
    expect(listTimespans).not.toHaveBeenCalled()
  })

  it('answers a signed-in request with spans, gaps and coverage', async () => {
    listTimespans.mockResolvedValue([
      { start: DAY_START, end: DAY_START + 6 * HOUR },
      { start: DAY_START + 7 * HOUR, end: DAY_END },
    ])

    const res = await app.request(url(FROM, TO), signedIn)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      window: { from: '2026-08-24T17:00:00.000Z', to: '2026-08-25T17:00:00.000Z' },
      spans: [
        { start: '2026-08-24T17:00:00.000Z', end: '2026-08-24T23:00:00.000Z', durationSec: 21600 },
        { start: '2026-08-25T00:00:00.000Z', end: '2026-08-25T17:00:00.000Z', durationSec: 61200 },
      ],
      gaps: [
        {
          start: '2026-08-24T23:00:00.000Z',
          end: '2026-08-25T00:00:00.000Z',
          durationSec: 3600,
          cause: 'unknown',
        },
      ],
      coverage: 1 - HOUR / (DAY_END - DAY_START),
    })
  })

  it('asks MediaMTX for the main path, never the sub-stream', async () => {
    await app.request(url(FROM, TO), signedIn)

    expect(listTimespans).toHaveBeenCalledWith('yard')
  })

  it('forbids caching', async () => {
    const res = await app.request(url(FROM, TO), signedIn)

    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('reads the gap cause from stream_events at the repository boundary', async () => {
    // The only place in the request where a Date exists. The stub returns what
    // drizzle returns - Date objects - and the assertion is on the cause, which
    // only lands if row.at.getTime() ran.
    queue.length = 0
    queue.push(CAMERA, [{ kind: 'down', at: new Date(DAY_START + 7 * HOUR) }], [])
    listTimespans.mockResolvedValue([
      { start: DAY_START, end: DAY_START + 6 * HOUR },
      { start: DAY_START + 8 * HOUR, end: DAY_END },
    ])

    const res = await app.request(url(FROM, TO), signedIn)
    const body = (await res.json()) as { gaps: { cause: string }[] }

    expect(body.gaps[0]?.cause).toBe('camera_down')
  })

  it('carries a down from before the window forward', async () => {
    queue.length = 0
    queue.push(CAMERA, [], [{ kind: 'down' }])

    const res = await app.request(url(FROM, TO), signedIn)
    const body = (await res.json()) as { gaps: { cause: string }[] }

    expect(body.gaps[0]?.cause).toBe('camera_down')
  })

  it('does not carry an up forward', async () => {
    queue.length = 0
    queue.push(CAMERA, [], [{ kind: 'up' }])

    const res = await app.request(url(FROM, TO), signedIn)
    const body = (await res.json()) as { gaps: { cause: string }[] }

    expect(body.gaps[0]?.cause).toBe('unknown')
  })

  describe('validation', () => {
    it('rejects a window that ends before it starts', async () => {
      const res = await app.request(url(TO, FROM), signedIn)

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_window' })
    })

    it('rejects a zero-length window', async () => {
      // coverage() would divide by zero and answer NaN, which JSON renders as
      // null while the response type still claims number.
      const res = await app.request(url(FROM, FROM), signedIn)

      expect(res.status).toBe(400)
    })

    it('rejects a timestamp with no zone', async () => {
      // A bare local string is the §8 bug in request form: it means a different
      // instant depending on who reads it.
      const res = await app.request(url('2026-08-25T00:00:00', TO), signedIn)

      expect(res.status).toBe(400)
    })

    it('rejects a date with no time', async () => {
      const res = await app.request(url('2026-08-25', TO), signedIn)

      expect(res.status).toBe(400)
    })

    it('rejects a missing bound', async () => {
      const res = await app.request(
        `/recordings/yard/timeline?from=${encodeURIComponent(FROM)}`,
        signedIn,
      )

      expect(res.status).toBe(400)
    })

    it('accepts a Z-suffixed window as readily as an offset one', async () => {
      const res = await app.request(url('2026-08-24T17:00:00Z', '2026-08-25T17:00:00Z'), signedIn)

      expect(res.status).toBe(200)
    })

    it('rejects a window longer than the retention period', async () => {
      const res = await app.request(url('2026-08-17T00:00:00Z', '2026-08-25T00:00:00Z'), signedIn)

      expect(res.status).toBe(400)
    })

    it('rejects a slug that could not name a MediaMTX path', async () => {
      const res = await app.request(url(FROM, TO, 'Yard!'), signedIn)

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_slug' })
    })

    it('rejects a window that has not started yet', async () => {
      nowSpy.mockReturnValue(DAY_START - HOUR)

      const res = await app.request(url(FROM, TO), signedIn)

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'window_in_future' })
    })
  })

  describe('failure modes', () => {
    it('reports an unknown camera without asking MediaMTX', async () => {
      queue.length = 0
      queue.push([], [], [])

      const res = await app.request(url(FROM, TO), signedIn)

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'unknown camera' })
      expect(listTimespans).not.toHaveBeenCalled()
    })

    it('reports a disabled camera as unknown', async () => {
      queue.length = 0
      queue.push([{ slug: 'yard', enabled: false }], [], [])

      const res = await app.request(url(FROM, TO), signedIn)

      expect(res.status).toBe(404)
    })

    // The playback API answers 400 - not 404 - for a path that has never
    // recorded. The camera is already known good by this point, so this is "no
    // footage", which is honestly zero coverage rather than a server error.
    it('reports a camera with no recordings as an empty timeline, not an error', async () => {
      listTimespans.mockRejectedValue(
        new MediaMtxError('/list - HTTP 400: lstat: no such file or directory', { status: 400 }),
      )

      const res = await app.request(url(FROM, TO), signedIn)
      const body = (await res.json()) as { spans: unknown[]; coverage: number; gaps: unknown[] }

      expect(res.status).toBe(200)
      expect(body.spans).toEqual([])
      expect(body.coverage).toBe(0)
      expect(body.gaps).toHaveLength(1)
    })

    it('refuses to guess when MediaMTX cannot be reached', async () => {
      // Degrading this to an empty list would draw a broken media server as a
      // total outage - the specific lie this endpoint exists to avoid.
      listTimespans.mockRejectedValue(new MediaMtxError('/list - unreachable'))

      const res = await app.request(url(FROM, TO), signedIn)

      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'mediamtx_unreachable' })
    })

    it('refuses to guess when MediaMTX answers with a shape it does not recognise', async () => {
      listTimespans.mockRejectedValue(new MediaMtxError('/list - unexpected shape'))

      const res = await app.request(url(FROM, TO), signedIn)

      expect(res.status).toBe(502)
    })
  })

  // docs/ARCHITECTURE.md#the-trust-boundary. Each timespan from /list carries a
  // url pointing at MediaMTX itself; listTimespans drops it and nothing else
  // enforces that it stays dropped.
  it('never leaks a MediaMTX address to the browser', async () => {
    listTimespans.mockResolvedValue([{ start: DAY_START, end: DAY_END }])

    const body = await (await app.request(url(FROM, TO), signedIn)).text()

    expect(body).not.toMatch(/rtsp/i)
    expect(body).not.toMatch(/127\.0\.0\.1/)
    expect(body).not.toMatch(/9996/)
  })
})

// The clip route proxies a video body rather than a parsed JSON value, so this
// block stubs global fetch the way live.test.ts does. Both idioms coexist: the
// module mock above still supplies listTimespans, and only the /get hop below
// goes through fetch.
describe('GET /recordings/:slug/clip', () => {
  const COVERED = '2026-08-25T09:00:00+07:00'
  const COVERED_MS = Date.parse(COVERED)

  // Two hours of footage with a one-hour hole in the middle of the day, so
  // there is a covered instant, a gap, and a span either side of it.
  const MORNING: Span = { start: DAY_START + 8 * HOUR, end: DAY_START + 10 * HOUR }
  const AFTERNOON: Span = { start: DAY_START + 11 * HOUR, end: DAY_START + 13 * HOUR }

  const clip = (start: string, query = '', slug = 'yard') =>
    `/recordings/${slug}/clip?start=${encodeURIComponent(start)}${query}`

  // A realistic /get answer: chunked video, no length, and the wildcard CORS
  // header and Server banner MediaMTX really does send.
  const mtxVideo = (body = 'fake-mp4-bytes') =>
    new Response(body, {
      status: 200,
      headers: {
        'content-type': 'video/mp4',
        'accept-ranges': 'none',
        'access-control-allow-origin': '*',
        server: 'mediamtx',
      },
    })

  const mtxError = (status: number, error: string) =>
    new Response(JSON.stringify({ status: 'error', error }), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const fetchMock = vi.fn()

  beforeEach(() => {
    // `queue` feeds one row set per select() call and shifts it off, so the
    // outer beforeEach's single entry only survives one request. The rate-limit
    // block makes thirty-one.
    queue.length = 0
    for (let i = 0; i < 40; i += 1) queue.push(CAMERA)

    listTimespans.mockResolvedValue([MORNING, AFTERNOON])
    clipRateLimit.reset()
    fetchMock.mockReset().mockImplementation(() => Promise.resolve(mtxVideo()))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('streams a covered instant', async () => {
    const res = await app.request(clip(COVERED), signedIn)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(await res.text()).toBe('fake-mp4-bytes')
  })

  it('asks MediaMTX for the main path, never the sub-stream', async () => {
    await app.request(clip(COVERED), signedIn)

    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(requested.pathname).toBe('/get')
    expect(requested.searchParams.get('path')).toBe('yard')
    expect(requested.searchParams.get('start')).toBe(new Date(COVERED_MS).toISOString())
  })

  // The body must reach the client as a stream. Reading it here to assert on it
  // would prove nothing, so this asserts the handler never read it: an upstream
  // body that is still unlocked and undisturbed by the time the Response is
  // built is one that was handed over rather than buffered.
  it('pipes the body instead of buffering it', async () => {
    const upstream = mtxVideo()
    fetchMock.mockResolvedValue(upstream)

    const res = await app.request(clip(COVERED), signedIn)

    expect(upstream.bodyUsed).toBe(false)
    expect(res.body).toBeInstanceOf(ReadableStream)
  })

  describe('range passthrough', () => {
    it('forwards the client Range header upstream', async () => {
      await app.request(clip(COVERED), {
        headers: { ...signedIn.headers, range: 'bytes=100-199' },
      })

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit
      expect(new Headers(init.headers).get('range')).toBe('bytes=100-199')
    })

    it('sends no Range header when the client sent none', async () => {
      await app.request(clip(COVERED), signedIn)

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit
      expect(init.headers).toBeUndefined()
    })

    // MediaMTX answers `Accept-Ranges: none` and ignores Range today, so this
    // drives a 206 that only a future MediaMTX would send. The point is that
    // the hop is faithful, not that the hop is currently exercised.
    it('survives a 206 with its status and range headers intact', async () => {
      fetchMock.mockResolvedValue(
        new Response('partial', {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': 'bytes 100-199/4096',
            'accept-ranges': 'bytes',
            'content-length': '100',
          },
        }),
      )

      const res = await app.request(clip(COVERED), {
        headers: { ...signedIn.headers, range: 'bytes=100-199' },
      })

      expect(res.status).toBe(206)
      expect(res.headers.get('content-range')).toBe('bytes 100-199/4096')
      expect(res.headers.get('accept-ranges')).toBe('bytes')
      expect(res.headers.get('content-length')).toBe('100')
    })

    it('forwards Accept-Ranges: none rather than inventing seekability', async () => {
      const res = await app.request(clip(COVERED), signedIn)

      expect(res.headers.get('accept-ranges')).toBe('none')
    })
  })

  // Copying upstream headers wholesale would put `Access-Control-Allow-Origin:
  // *` on a credentialed response, which the browser rejects outright - and the
  // CORS middleware in index.ts is the only thing entitled to set it.
  it('does not forward the MediaMTX CORS header or its Server banner', async () => {
    const res = await app.request(clip(COVERED), signedIn)

    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('server')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  describe('gaps', () => {
    const IN_GAP = '2026-08-25T10:30:00+07:00'

    it('answers 409 rather than an empty video', async () => {
      const res = await app.request(clip(IN_GAP), signedIn)

      expect(res.status).toBe(409)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('names the nearest span so the UI has something to offer', async () => {
      const res = await app.request(clip(IN_GAP), signedIn)

      expect(await res.json()).toEqual({
        error: 'gap',
        requested: new Date(Date.parse(IN_GAP)).toISOString(),
        nearest: {
          start: new Date(AFTERNOON.start).toISOString(),
          end: new Date(AFTERNOON.end).toISOString(),
          durationSec: 7200,
        },
      })
    })

    it('reports no nearest span when nothing was ever recorded', async () => {
      listTimespans.mockResolvedValue([])

      const res = await app.request(clip(COVERED), signedIn)

      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ nearest: null })
    })

    // The instant at a span's end belongs to the gap after it, which is what
    // gaps() and resolve() already agree on.
    it('treats the exact end of a span as a gap', async () => {
      const res = await app.request(clip(new Date(MORNING.end).toISOString()), signedIn)

      expect(res.status).toBe(409)
    })

    // Nothing has been recorded in a second that has not happened. Without the
    // clamp, MediaMTX's reported end for the segment it is still writing runs
    // past the present and this would proxy a request for the future.
    it('answers 409 for an instant that has not happened yet', async () => {
      listTimespans.mockResolvedValue([{ start: DAY_START, end: SETTLED + HOUR }])

      const res = await app.request(clip(new Date(SETTLED + 30 * MINUTE).toISOString()), signedIn)

      expect(res.status).toBe(409)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    // Sub-TOLERANCE_MS muxer boundaries are not holes. A click landing in one
    // must play, not 409.
    it('plays an instant inside a muxer boundary', async () => {
      listTimespans.mockResolvedValue([
        { start: DAY_START + 8 * HOUR, end: DAY_START + 9 * HOUR },
        { start: DAY_START + 9 * HOUR + 400, end: DAY_START + 10 * HOUR },
      ])

      const res = await app.request(
        clip(new Date(DAY_START + 9 * HOUR + 200).toISOString()),
        signedIn,
      )

      expect(res.status).toBe(200)
    })
  })

  describe('validation', () => {
    it('defaults duration to 300 seconds', async () => {
      await app.request(clip(COVERED), signedIn)

      const requested = new URL(String(fetchMock.mock.calls[0]?.[0]))
      expect(requested.searchParams.get('duration')).toBe('300')
    })

    it('passes an explicit duration through', async () => {
      await app.request(clip(COVERED, '&duration=60'), signedIn)

      const requested = new URL(String(fetchMock.mock.calls[0]?.[0]))
      expect(requested.searchParams.get('duration')).toBe('60')
    })

    // SPEC 15: the endpoint may not be turned into a request for a week of
    // video in one response.
    it('rejects a duration over an hour', async () => {
      const res = await app.request(clip(COVERED, '&duration=3601'), signedIn)

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_clip' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('accepts exactly an hour', async () => {
      const res = await app.request(clip(COVERED, '&duration=3600'), signedIn)

      expect(res.status).toBe(200)
    })

    it.each(['0', '-30', '1.5', 'abc', ''])('rejects duration=%s', async (duration) => {
      const res = await app.request(clip(COVERED, `&duration=${duration}`), signedIn)

      expect(res.status).toBe(400)
    })

    it('rejects a start that is not RFC3339', async () => {
      const res = await app.request(clip('25-08-2026 09:00'), signedIn)

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_clip' })
    })

    it('rejects a start with no offset', async () => {
      const res = await app.request(clip('2026-08-25T09:00:00'), signedIn)

      expect(res.status).toBe(400)
    })

    it('rejects a slug that could not name a MediaMTX path', async () => {
      const res = await app.request(clip(COVERED, '', 'Yard!'), signedIn)

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_slug' })
    })
  })

  describe('failure modes', () => {
    it('rejects a request with no session before doing any work', async () => {
      getSession.mockResolvedValue(null)

      const res = await app.request(clip(COVERED))

      expect(res.status).toBe(401)
      expect(select).not.toHaveBeenCalled()
      expect(listTimespans).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('answers 401 rather than 400 for an unauthenticated malformed request', async () => {
      getSession.mockResolvedValue(null)

      const res = await app.request('/recordings/yard/clip')

      expect(res.status).toBe(401)
    })

    it('answers 404 for a camera that is not ours', async () => {
      queue.length = 0
      queue.push([], [], [])

      const res = await app.request(clip(COVERED), signedIn)

      expect(res.status).toBe(404)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('answers 502 when the timespan list cannot be read', async () => {
      listTimespans.mockRejectedValue(new MediaMtxError('unreachable'))

      const res = await app.request(clip(COVERED), signedIn)

      expect(res.status).toBe(502)
    })

    // /get separates the two cases where /list does not: 404 is "no segments
    // there", 400 is "no such path". A 404 after this route already checked
    // means retention deleted the segment mid-request, which is a gap.
    it('turns an upstream 404 into a 409 with the nearest span', async () => {
      fetchMock.mockResolvedValue(mtxError(404, 'no recording segments found'))

      const res = await app.request(clip(COVERED), signedIn)

      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({
        nearest: { start: new Date(MORNING.start).toISOString() },
      })
    })

    it('turns an upstream 400 into a 502', async () => {
      fetchMock.mockResolvedValue(mtxError(400, "path 'yard' is not configured"))

      const res = await app.request(clip(COVERED), signedIn)

      expect(res.status).toBe(502)
    })

    it('never answers a rejected upstream with its JSON body as video', async () => {
      fetchMock.mockResolvedValue(mtxError(404, 'no recording segments found'))

      const body = await (await app.request(clip(COVERED), signedIn)).text()

      expect(body).not.toMatch(/no recording segments found/)
    })

    it('answers 502 when MediaMTX cannot be reached at all', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'))

      const res = await app.request(clip(COVERED), signedIn)

      expect(res.status).toBe(502)
    })
  })

  describe('the rate limit', () => {
    // SPEC 15: 30 clip requests per minute per user. One clip makes MediaMTX
    // mux up to an hour of video, so the bound is on work done upstream.
    it('allows 30 requests a minute and refuses the 31st', async () => {
      for (let i = 0; i < 30; i += 1) {
        expect((await app.request(clip(COVERED), signedIn)).status).toBe(200)
      }

      const res = await app.request(clip(COVERED), signedIn)

      expect(res.status).toBe(429)
      expect(await res.json()).toEqual({ error: 'rate_limited' })
    })

    it('counts a request the validators rejected', async () => {
      for (let i = 0; i < 30; i += 1) {
        await app.request(clip(COVERED, '&duration=99999'), signedIn)
      }

      expect((await app.request(clip(COVERED), signedIn)).status).toBe(429)
    })

    it('does not limit the timeline route', async () => {
      for (let i = 0; i < 31; i += 1) await app.request(clip(COVERED), signedIn)

      queue.length = 0
      queue.push(CAMERA, [], [])

      expect((await app.request(url(FROM, TO), signedIn)).status).toBe(200)
    })
  })

  // docs/ARCHITECTURE.md#the-trust-boundary. The 409 body is built from the
  // same timespans whose `url` field points straight at the media server.
  it('never leaks a MediaMTX address to the browser', async () => {
    const body = await (await app.request(clip('2026-08-25T10:30:00+07:00'), signedIn)).text()

    expect(body).not.toMatch(/rtsp/i)
    expect(body).not.toMatch(/127\.0\.0\.1/)
    expect(body).not.toMatch(/9996/)
  })
})
