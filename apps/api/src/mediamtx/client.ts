import { z } from 'zod'

// Both loopback (SPEC 15): the authenticated API is the only way to reach a
// stream. The defaults match .env.example so `bun run test` — which loads no
// env file — resolves the same URLs as `bun dev`.
//
// process.env, not Bun.env, and global fetch, not Bun's: apps/web typechecks a
// type-only import of ../index, which pulls this file into ITS program, and
// that program has no @types/bun. A Bun global here fails the web CI job with
// an error pointing at a file in the other app.
const CONTROL_URL = process.env.MEDIAMTX_API_URL ?? 'http://127.0.0.1:9997'
const PLAYBACK_URL = process.env.MEDIAMTX_PLAYBACK_URL ?? 'http://127.0.0.1:9996'

// MediaMTX is on loopback, so anything slower than a few seconds is a hang, not
// latency. Without a deadline a wedged MediaMTX makes GET /cameras outlive the
// browser's own 10s poll interval and the page spins instead of saying
// "offline" — which is the one thing this app must never do.
const TIMEOUT_MS = 3_000

export class MediaMtxError extends Error {
  readonly status?: number

  constructor(message: string, options?: ErrorOptions & { status?: number }) {
    super(`mediamtx: ${message}`, options)
    this.name = 'MediaMtxError'
    this.status = options?.status
  }
}

// The RFC3339 -> epoch-ms boundary (SPEC 8.3), and the only one. MediaMTX
// speaks RFC3339; everything inside this process is epoch milliseconds UTC and
// nothing downstream ever sees a Date.
//
// offset: true because /list carries an offset rather than Z when MediaMTX runs
// outside UTC. Date.parse truncates MediaMTX's sub-millisecond fractions
// (readyTime has 8 digits) to whole milliseconds, which is three orders of
// magnitude below TOLERANCE_MS.
const epochMs = z.iso
  .datetime({ offset: true })
  .transform((iso) => Date.parse(iso))
  .refine(Number.isFinite, 'unparsable RFC3339 timestamp')

// Only the fields the application actually uses; z.object() strips the rest, so
// MediaMTX adding a field is not a breaking change.
//
// `online` is absent ON PURPOSE. MediaMTX reports online:true for an idle
// on-demand path — yard_sub sits at online:true with onlineTime
// 0001-01-01T00:00:00Z while nothing is connected — so reading `online` marks a
// camera that has been down for hours as live. `ready` is the signal. Leaving
// `online` out of the schema means it cannot be reached by accident later.
const pathSchema = z.object({
  name: z.string(),
  ready: z.boolean(),
  // string | null on the wire: null whenever the path has never been ready.
  // Nullable at the domain level too — do not default it to 0.
  readyTime: epochMs.nullable(),
  tracks: z.array(z.string()),
  // id is "" when nothing is publishing; MediaMTX can also send null here.
  source: z.object({ type: z.string(), id: z.string() }).nullable(),
})

const pathListSchema = z.object({
  itemCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative(),
  items: z.array(pathSchema),
})

// The control API answers errors with a completely different envelope from
// success — {"status":"error","error":"path not found"}, not a path object — so
// an error has to be detected by HTTP status and parsed with its own schema.
// Feeding it to pathSchema fails validation and reads as "MediaMTX is broken"
// when the truth is "that path is not configured". looseObject so a future
// field does not turn a good 404 into a parse failure.
const controlErrorSchema = z.looseObject({ error: z.string() })

// The playback API returns a BARE ARRAY — no itemCount/items envelope, unlike
// every endpoint on the control API. Same server, two different shapes.
const timespanSchema = z.object({
  start: epochMs,
  duration: z.number().nonnegative(), // float SECONDS, up to 12 decimal places
  url: z.url(), // points at MediaMTX itself — never handed to the browser
})

export type MediaMtxPath = z.infer<typeof pathSchema>

// duration is folded into `end` here rather than downstream: seconds are a
// wire-format detail, and timeline/ must only ever see epoch-ms spans (SPEC 8.3).
export type Timespan = { start: number; end: number }

async function fetchJson(url: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (cause) {
    throw new MediaMtxError(`${url} - unreachable`, { cause })
  }

  if (!res.ok) {
    const detail = controlErrorSchema.safeParse(await res.json().catch(() => null))
    throw new MediaMtxError(
      `${url} - HTTP ${res.status}${detail.success ? `: ${detail.data.error}` : ''}`,
      { status: res.status },
    )
  }

  try {
    return await res.json()
  } catch (cause) {
    throw new MediaMtxError(`${url} - body was not JSON`, { cause })
  }
}

// Validated rather than cast: a MediaMTX upgrade that renames a field should
// fail here, loudly, not read as `undefined` three layers away.
function parse<S extends z.ZodType>(schema: S, value: unknown, url: string): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new MediaMtxError(`${url} - unexpected shape\n${z.prettifyError(result.error)}`)
  }
  return result.data
}

// Runtime state, NOT /v3/config/paths/list. The config endpoint returns the
// CONFIGURED source, which for a real camera is
// rtsp://<ip>:5543/<md5(ONVIF_PASSWORD)>/live/channel0 — proxying it would ship
// a password hash to the browser (SPEC 15). This endpoint carries no secret.
export async function listPaths(): Promise<MediaMtxPath[]> {
  const url = `${CONTROL_URL}/v3/paths/list`
  return parse(pathListSchema, await fetchJson(url), url).items
}

// null means "no such path", which is a different fact from "MediaMTX is down"
// — that still throws.
export async function getPath(name: string): Promise<MediaMtxPath | null> {
  // encodeURIComponent even though slugs come from our own database: it is what
  // stops a slug ever escaping into another control-API endpoint.
  const url = `${CONTROL_URL}/v3/paths/get/${encodeURIComponent(name)}`

  let body: unknown
  try {
    body = await fetchJson(url)
  } catch (error) {
    if (error instanceof MediaMtxError && error.status === 404) return null
    throw error
  }

  return parse(pathSchema, body, url)
}

// The open span is deliberately NOT clamped to now here — that is timeline/
// work (SPEC 8, item 4), and calling Date.now() would make this untestable.
export async function listTimespans(path: string): Promise<Timespan[]> {
  const url = `${PLAYBACK_URL}/list?path=${encodeURIComponent(path)}`

  return parse(z.array(timespanSchema), await fetchJson(url), url).map((span) => ({
    start: span.start,
    // Rounded to whole ms. The residue is sub-millisecond and TOLERANCE_MS is
    // 2000, so it cannot move a span across a gap boundary.
    end: Math.round(span.start + span.duration * 1000),
  }))
}

// The epoch-ms -> RFC3339 boundary, in the other direction: MediaMTX cuts on
// wall-clock time and takes RFC3339, so the conversion happens here and not in
// the caller. The clip route (build order 8) streams this URL rather than
// buffering it (SPEC 9); it is never handed to the browser.
export function clipUrl(path: string, startMs: number, durationSec: number): string {
  const params = new URLSearchParams({
    path,
    start: new Date(startMs).toISOString(),
    duration: String(durationSec),
  })

  return `${PLAYBACK_URL}/get?${params}`
}
