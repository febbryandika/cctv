import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaMtxError } from '../mediamtx/client'
import type * as MediaMtxClient from '../mediamtx/client'
import { TOLERANCE_MS, type Span, type StreamEvent } from '../timeline/coverage'
import { buildTimeline, recordingsRoute } from './recordings'

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
