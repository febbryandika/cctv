import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clipUrl, getPath, listPaths, listTimespans, MediaMtxError } from './client'

// Captured verbatim from a running MediaMTX (GET /v3/paths/list). Trimmed of
// paths, not of fields: the fields the schema strips are exactly the ones a
// future change might start depending on by accident.
const PATH_LIST = {
  itemCount: 2,
  pageCount: 1,
  items: [
    {
      name: 'yard',
      confName: 'yard',
      ready: true,
      readyTime: '2026-08-25T13:13:01.02999481Z',
      available: true,
      availableTime: '2026-08-25T13:13:01.02999481Z',
      online: true,
      onlineTime: '2026-08-25T13:13:01.029998768Z',
      source: { type: 'rtspSession', id: '46bdf5f1-ce1e-45d9-986f-239a61b07847' },
      tracks: ['H264'],
      tracks2: [
        {
          codec: 'H264',
          codecProps: { width: 1920, height: 1080, profile: 'Baseline', level: '4' },
        },
      ],
      readers: [],
      bytesReceived: 297706723,
      bytesSent: 0,
    },
    {
      name: 'yard_sub',
      confName: 'yard_sub',
      ready: false,
      readyTime: null,
      available: false,
      availableTime: null,
      // An idle on-demand path is `online` with a ZERO-VALUE onlineTime. This
      // is the whole reason the client reads `ready` and not `online`.
      online: true,
      onlineTime: '0001-01-01T00:00:00Z',
      source: { type: 'rtspSource', id: '' },
      tracks: [],
      tracks2: [],
      readers: [],
      bytesReceived: 0,
      bytesSent: 0,
    },
  ],
}

// The playback API answers with a bare array — no envelope.
const TIMESPANS = [
  {
    start: '2026-08-25T12:29:24.278292Z',
    duration: 106.899,
    url: 'http://127.0.0.1:9996/get?duration=106.899&path=yard&start=2026-08-25T12%3A29%3A24.278292Z',
  },
  {
    start: '2026-08-25T15:43:15.900027Z',
    duration: 1155.033231222,
    url: 'http://127.0.0.1:9996/get?duration=1155.033231222&path=yard&start=2026-08-25T15%3A43%3A15.900027Z',
  },
]

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listPaths', () => {
  it('asks the runtime endpoint, not the config one', async () => {
    fetchMock.mockResolvedValue(ok(PATH_LIST))

    await listPaths()

    // /v3/config/paths/list returns the configured RTSP source, which contains
    // md5(ONVIF_PASSWORD) (docs/ARCHITECTURE.md#the-trust-boundary). This
    // assertion is the guard.
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9997/v3/paths/list')
  })

  it('parses a captured control-API response', async () => {
    fetchMock.mockResolvedValue(ok(PATH_LIST))

    await expect(listPaths()).resolves.toEqual([
      {
        name: 'yard',
        ready: true,
        readyTime: 1787663581029,
        tracks: ['H264'],
        source: { type: 'rtspSession', id: '46bdf5f1-ce1e-45d9-986f-239a61b07847' },
      },
      {
        name: 'yard_sub',
        ready: false,
        readyTime: null,
        tracks: [],
        source: { type: 'rtspSource', id: '' },
      },
    ])
  })

  // The literal is the point: a `new Date(...).getTime()` expectation would be
  // computed the same wrong way as the code and pass in every timezone. This
  // number is fixed, and CI runs this file under both UTC and Asia/Jakarta.
  it('converts readyTime to epoch milliseconds UTC, not local time', async () => {
    fetchMock.mockResolvedValue(ok(PATH_LIST))

    expect((await listPaths())[0]?.readyTime).toBe(1787663581029)
  })

  it('throws when MediaMTX is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    await expect(listPaths()).rejects.toBeInstanceOf(MediaMtxError)
  })

  it('throws rather than casting when the shape changes', async () => {
    fetchMock.mockResolvedValue(ok({ itemCount: 1, pageCount: 1, items: [{ name: 'yard' }] }))

    await expect(listPaths()).rejects.toBeInstanceOf(MediaMtxError)
  })
})

describe('getPath', () => {
  it('returns null for the 404 error envelope', async () => {
    // Note the shape: {status, error}, nothing like a path object.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'error', error: 'path not found' }), { status: 404 }),
    )

    await expect(getPath('nonexistent')).resolves.toBeNull()
  })

  it('throws on any other error status', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))

    await expect(getPath('yard')).rejects.toBeInstanceOf(MediaMtxError)
  })

  it('parses a single path', async () => {
    fetchMock.mockResolvedValue(ok(PATH_LIST.items[0]))

    await expect(getPath('yard')).resolves.toMatchObject({ name: 'yard', ready: true })
  })
})

describe('listTimespans', () => {
  it('parses the bare array and folds duration into an epoch-ms end', async () => {
    fetchMock.mockResolvedValue(ok(TIMESPANS))

    await expect(listTimespans('yard')).resolves.toEqual([
      { start: 1787660964278, end: 1787661071177 },
      // 12 decimal places of float seconds, rounded to whole milliseconds.
      { start: 1787672595900, end: 1787673750933 },
    ])
  })
})

describe('clipUrl', () => {
  it('converts epoch ms back to RFC3339 at the wire boundary', () => {
    expect(clipUrl('yard', 1787663581029, 300)).toBe(
      'http://127.0.0.1:9996/get?path=yard&start=2026-08-25T13%3A13%3A01.029Z&duration=300',
    )
  })
})
