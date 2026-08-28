// Reports how well this thing actually worked over the last 24 hours
// (docs/ARCHITECTURE.md#measurement): coverage and where the holes are, what
// storage really costs, and how long the operator waits for a picture. The
// coverage number is the one that goes in the README, and the point of the
// script is that it is measured rather than claimed.
//
//   cd apps/api && bun run measure
//
// Needs the whole local stack — Compose, the API on :3001, a seeded operator —
// and real elapsed time, so it stays manual and out of CI. Exits non-zero when a
// number misses its target, so it can gate a deployment.

import { and, desc, eq, gte, lt } from 'drizzle-orm'
import { chromium } from 'playwright-core'
import { db, sql } from '../src/db'
import { cameras, streamEvents } from '../src/db/schema'
import { listTimespans } from '../src/mediamtx/client'
import {
  TOLERANCE_MS,
  clampToNow,
  coverage,
  gaps,
  inferCause,
  merge,
  type Span,
  type StreamEvent,
} from '../src/timeline/coverage'

const WINDOW_MS = 24 * 60 * 60 * 1000

// The three targets. Named, so that missing one is a decision someone made
// rather than a threshold buried in a conditional.
const MIN_COVERAGE = 0.99
const MAX_FIRST_FRAME_MS = 2_000
const ATTEMPTS = 5

const REPO_ROOT = new URL('../../../', import.meta.url)
const MEDIAMTX_YML = new URL('mediamtx.yml', REPO_ROOT)
// The trailing slash is load-bearing: without it, resolving a camera's
// subdirectory against this URL replaces the last segment instead of descending
// into it, and the scan silently reads the wrong directory.
const RECORDINGS_DIR = new URL(
  `${(Bun.env.RECORDINGS_DIR ?? './recordings').replace(/\/+$/, '')}/`,
  REPO_ROOT,
)

const API_URL = Bun.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const EMAIL = Bun.env.SEED_OPERATOR_EMAIL ?? 'operator@ronda.local'
const PASSWORD = Bun.env.SEED_OPERATOR_PASSWORD ?? 'ronda-operator'

const GB = 1_000_000_000
const gb = (bytes: number) => `${(bytes / GB).toFixed(2)} GB`
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(0)} MB`

function human(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// The render boundary, and the only place a wall-clock string is produced
// (docs/ARCHITECTURE.md#timeline-gaps-and-coverage). Everything above this line
// is epoch milliseconds UTC.
const CAMERA_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const clock = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { hour12: false, dateStyle: 'short', timeStyle: 'medium' })

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

// `${n}m`, `${n}h`, `${n}s` as MediaMTX writes them. The trailing-comment guard
// matters: the rendered config carries `recordDeleteAfter: 168h # 7 days`.
function configSeconds(yml: string, key: string, fallback: number): number {
  const match = new RegExp(`^\\s*${key}:\\s*(\\d+)([smh])`, 'm').exec(yml)
  if (!match) return fallback

  const value = Number(match[1])
  const unit = match[2]
  return unit === 'h' ? value * 3600 : unit === 'm' ? value * 60 : value
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
  const stdout = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? stdout : ''
}

// No statvfs in Bun, and `df -P` is the POSIX-portable output format: available
// space is field 3 on both macOS and Linux.
async function freeBytes(dir: URL): Promise<number> {
  const line = (await run(['df', '-Pk', Bun.fileURLToPath(dir)])).trim().split('\n').at(-1) ?? ''
  const available = line.split(/\s+/)[3]
  return available === undefined ? 0 : Number(available) * 1024
}

// The repository boundary: Date in, epoch milliseconds out, and nothing below
// this line ever sees a Date (docs/ARCHITECTURE.md#timeline-gaps-and-coverage).
//
// The carry-forward is not optional. inferCause only matches a `down` event
// INSIDE the gap, so an outage that began before the window opened would leave
// its gap reading `unknown` — precisely the biggest outage, reported as the
// least explicable.
async function loadEvents(slug: string, window: Span): Promise<StreamEvent[]> {
  const rows = await db
    .select({ kind: streamEvents.kind, at: streamEvents.at })
    .from(streamEvents)
    .where(
      and(
        eq(streamEvents.cameraSlug, slug),
        gte(streamEvents.at, new Date(window.start)),
        lt(streamEvents.at, new Date(window.end)),
      ),
    )
    .orderBy(streamEvents.at)

  const [previous] = await db
    .select({ kind: streamEvents.kind })
    .from(streamEvents)
    .where(and(eq(streamEvents.cameraSlug, slug), lt(streamEvents.at, new Date(window.start))))
    .orderBy(desc(streamEvents.at))
    .limit(1)

  const inWindow: StreamEvent[] = rows.map((row) => ({ kind: row.kind, at: row.at.getTime() }))
  return previous?.kind === 'down' ? [{ kind: 'down', at: window.start }, ...inWindow] : inWindow
}

// Segment files are weighed, never parsed for their timestamps. MediaMTX writes
// `recordPath` with strftime in ITS OWN local time, which inside the container
// is UTC while the host here runs Asia/Jakarta — so a filename that looks local
// is not, and reading it as either is a seven-hour bug waiting for a different
// deployment. mtime is an unambiguous instant and needs no zone at all.
async function segmentBytes(slug: string, window: Span) {
  const dir = new URL(`${slug}/`, RECORDINGS_DIR)
  const sizes: number[] = []
  let total = 0

  let names: AsyncIterable<string>
  try {
    names = new Bun.Glob('*.mp4').scan({ cwd: Bun.fileURLToPath(dir) })
  } catch {
    // A camera that has never recorded has no directory. Zero bytes is the
    // honest answer; the coverage number already says the same thing.
    return { total, sizes }
  }

  for await (const name of names) {
    const stat = await Bun.file(new URL(name, dir)).stat()
    // A segment still being written when the window opened is counted whole,
    // which over 24 hours overstates by at most one segment at one edge.
    if (stat.mtimeMs < window.start) continue
    sizes.push(stat.size)
    total += stat.size
  }

  return { total, sizes }
}

type Attempt = { post: number; frame: number } | { error: string }

// These run in the BROWSER, where they exist. apps/api's tsconfig has no "DOM"
// lib — this is a Bun server — so the handful of globals the page function needs
// are declared here rather than pulling the whole DOM into the API's program.
// Ambient declarations emit nothing; Playwright ships the function's source to
// the page, where the real objects are.
type SessionDescription = { type: string; sdp: string }
type PeerConnection = {
  iceGatheringState: string
  localDescription: SessionDescription | null
  addTransceiver: (kind: string, init: { direction: string }) => void
  createOffer: () => Promise<SessionDescription>
  setLocalDescription: (description: SessionDescription) => Promise<void>
  setRemoteDescription: (description: SessionDescription) => Promise<void>
  addEventListener: (type: string, listener: (event: { streams: unknown[] }) => void) => void
  removeEventListener: (type: string, listener: () => void) => void
  close: () => void
}
type FrameVideo = {
  autoplay: boolean
  muted: boolean
  srcObject: unknown
  requestVideoFrameCallback: (callback: () => void) => void
}
declare const RTCPeerConnection: new () => PeerConnection
declare const document: {
  createElement: (tag: string) => FrameVideo
  body: { appendChild: (node: FrameVideo) => void }
}

// One WHEP handshake, timed. Mirrors components/live-player.tsx: complete offer
// rather than trickle, because with host candidates only there is nothing to
// trickle and gathering beats the round-trip.
async function attempt({
  apiUrl,
  slug,
  timeoutMs,
}: {
  apiUrl: string
  slug: string
  timeoutMs: number
}): Promise<Attempt> {
  const pc = new RTCPeerConnection()
  pc.addTransceiver('video', { direction: 'recvonly' })
  await pc.setLocalDescription(await pc.createOffer())

  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const done = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    const timer = setTimeout(done, 1_000)
    pc.addEventListener('icegatheringstatechange', onChange)
  })

  const video = document.createElement('video')
  video.autoplay = true
  video.muted = true
  document.body.appendChild(video)

  // Armed before the POST: the track can arrive before setRemoteDescription
  // returns, and a listener attached afterwards would miss the first frame.
  const decoded = new Promise<number>((resolve) => {
    pc.addEventListener('track', (event) => {
      video.srcObject = event.streams[0]
      video.requestVideoFrameCallback(() => resolve(performance.now()))
    })
  })

  const started = performance.now()
  const offer = pc.localDescription?.sdp ?? ''
  const res = await fetch(`${apiUrl}/live/${slug}/whep`, {
    method: 'POST',
    headers: { 'content-type': 'application/sdp' },
    body: offer,
    credentials: 'include',
  })
  const posted = performance.now()

  if (!res.ok) {
    pc.close()
    // 503 is camera_offline, not a slow network — worth saying so.
    return { error: res.status === 503 ? 'camera offline' : `WHEP POST responded ${res.status}` }
  }

  const location = res.headers.get('location')
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })

  const frame = await Promise.race([
    decoded,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])

  pc.close()
  // Without this, entries accumulate against SESSION_TTL_MS in routes/live.ts.
  if (location !== null) {
    await fetch(new URL(location, apiUrl).toString(), {
      method: 'DELETE',
      credentials: 'include',
    }).catch(() => {})
  }

  return frame === null
    ? { error: 'no decoded frame before timeout' }
    : { post: posted - started, frame: frame - started }
}

async function timeToFirstFrame(slug: string) {
  let browser
  try {
    browser = await chromium.launch()
  } catch (error) {
    // playwright-core deliberately downloads no browser of its own; it reuses
    // the one apps/web's @playwright/test (same exact version) installed.
    return {
      error:
        `chromium would not launch (${error instanceof Error ? error.message.split('\n')[0] : error}). ` +
        'Run `pnpm --dir ../web exec playwright install chromium`.',
    }
  }

  try {
    const context = await browser.newContext()

    // Signed in with plain fetch rather than Playwright's request context, which
    // receives the response and then hangs waiting on it. The session cookie is
    // handed to the browser directly instead — same result, one moving part
    // fewer, and it is the same API sign-in apps/web/e2e/auth.setup.ts uses.
    const signIn = await fetch(`${API_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }).catch(() => null)

    if (signIn === null || !signIn.ok) {
      return {
        error:
          `sign-in failed (${signIn?.status ?? 'unreachable'}) — is the API up on ${API_URL}, ` +
          'and do SEED_OPERATOR_EMAIL / SEED_OPERATOR_PASSWORD match `bun run db:seed`?',
      }
    }

    await context.addCookies(
      signIn.headers.getSetCookie().map((line) => {
        const pair = line.split(';', 1)[0] ?? ''
        const split = pair.indexOf('=')
        return { name: pair.slice(0, split), value: pair.slice(split + 1), url: API_URL }
      }),
    )

    const posts: number[] = []
    const frames: number[] = []
    const errors: string[] = []

    for (let i = 0; i < ATTEMPTS; i++) {
      const page = await context.newPage()
      // The API's own origin, so the WHEP fetch is same-origin: no CORS, and the
      // rewritten Location header is readable without exposeHeaders. Also a
      // secure context, which RTCPeerConnection requires.
      await page.goto(API_URL)

      const result = await page.evaluate(attempt, {
        apiUrl: API_URL,
        slug,
        timeoutMs: MAX_FIRST_FRAME_MS * 5,
      })
      await page.close()

      if ('error' in result) errors.push(result.error)
      else {
        posts.push(result.post)
        frames.push(result.frame)
      }
    }

    if (frames.length === 0) return { error: errors[0] ?? 'no attempt produced a frame' }
    return { post: median(posts), frame: median(frames), failed: errors.length }
  } finally {
    await browser.close()
  }
}

const now = Date.now()
const window: Span = { start: now - WINDOW_MS, end: now }

const yml = (await Bun.file(MEDIAMTX_YML).exists()) ? await Bun.file(MEDIAMTX_YML).text() : ''
const segmentSec = configSeconds(yml, 'recordSegmentDuration', 600)
const retentionDays = configSeconds(yml, 'recordDeleteAfter', 168 * 3600) / 86_400

const enabled = await db
  .select({ slug: cameras.slug, name: cameras.name })
  .from(cameras)
  .where(eq(cameras.enabled, true))

if (enabled.length === 0) {
  console.error('measure: no enabled cameras — run `bun run db:seed`')
  await sql.end()
  process.exit(1)
}

const failures: string[] = []
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${name.padEnd(18)}${ok ? 'ok  ' : 'FAIL'}  ${detail}`)
  if (!ok) failures.push(name)
}

console.log(`measure: ${clock(window.start)} → ${clock(window.end)} (${CAMERA_TZ})\n`)

for (const camera of enabled) {
  const raw = await listTimespans(camera.slug).catch((error: unknown) => {
    console.error(`measure: MediaMTX /list failed for ${camera.slug} -`, error)
    return null
  })

  if (raw === null) {
    failures.push(`${camera.slug} timespans`)
    continue
  }

  const events = await loadEvents(camera.slug, window)

  // coverage() is exact; the printed table drops sub-tolerance holes, so it can
  // sit a hair under 1 with an empty table. Never re-derive one from the other.
  const fraction = coverage(raw, window)
  const holes = gaps(raw, window).filter((g) => g.end - g.start > TOLERANCE_MS)

  console.log(`measure: coverage (${camera.slug})`)
  console.log(`  coverage          ${(fraction * 100).toFixed(2)}%`)
  console.log(`  gaps              ${holes.length} over ${TOLERANCE_MS / 1000}s`)

  if (holes.length > 0) {
    console.log(`\n  ${'from'.padEnd(21)}${'duration'.padEnd(11)}cause`)
    for (const hole of holes) {
      const duration = human((hole.end - hole.start) / 1000)
      console.log(
        `  ${clock(hole.start).padEnd(21)}${duration.padEnd(11)}${inferCause(hole, events)}`,
      )
    }
  }

  // Reported seconds, clamped: MediaMTX's reported duration for the segment
  // currently being written can run past now
  // (docs/ARCHITECTURE.md#timeline-gaps-and-coverage).
  const reportedSec =
    merge(clampToNow(raw, now))
      .filter((s) => s.end > window.start && s.start < window.end)
      .reduce((n, s) => n + (Math.min(s.end, window.end) - Math.max(s.start, window.start)), 0) /
    1000

  const { total, sizes } = await segmentBytes(camera.slug, window)

  // The independent ruler: a complete segment is recordSegmentDuration long, so
  // the median segment size divided by that is a bytes-per-second the reported
  // durations had no part in producing. Median rather than mean because a run
  // that was interrupted leaves short segments behind.
  const bytesPerSec = median(sizes) / segmentSec
  const impliedSec = bytesPerSec > 0 ? total / bytesPerSec : 0
  const drift = reportedSec - impliedSec

  const free = await freeBytes(RECORDINGS_DIR)
  const bytesPerDay = total * (86_400_000 / WINDOW_MS)
  const daysUntilFull = bytesPerDay > 0 ? free / bytesPerDay : Infinity

  console.log(`\nmeasure: storage (${camera.slug})`)
  console.log(`  written           ${gb(total)} in 24h (${mb(total / 24)}/hour)`)
  console.log(
    `  projected         ${gb(bytesPerDay)}/day, ${gb(free)} free = ${daysUntilFull.toFixed(1)} days`,
  )
  console.log(`  reported          ${human(reportedSec)} from MediaMTX /list`)
  console.log(
    `  on disk           ${human(impliedSec)} implied by size at ${(bytesPerSec / 1000).toFixed(1)} kB/s`,
  )
  console.log(
    `  discrepancy       ${drift >= 0 ? '+' : '-'}${human(Math.abs(drift))} ` +
      `(${reportedSec > 0 ? ((drift / reportedSec) * 100).toFixed(2) : '0.00'}%)`,
  )

  console.log(`\nmeasure: checks (${camera.slug})`)
  check(
    'coverage',
    fraction >= MIN_COVERAGE,
    `${(fraction * 100).toFixed(2)}% against a ${(MIN_COVERAGE * 100).toFixed(0)}% target`,
  )
  check(
    'retention',
    daysUntilFull >= retentionDays,
    `${daysUntilFull.toFixed(1)} days of free disk, recordDeleteAfter keeps ${retentionDays.toFixed(0)}`,
  )
}

// One camera's worth: the number describes the operator's wait, and every
// camera shares the same proxy and the same machine.
const first = enabled[0]
if (first !== undefined) {
  console.log(`\nmeasure: time to first frame (median of ${ATTEMPTS}, ${first.slug})`)
  const ttff = await timeToFirstFrame(first.slug)

  if ('error' in ttff) {
    console.log(`  ${'first frame'.padEnd(18)}FAIL  ${ttff.error}`)
    failures.push('first frame')
  } else {
    console.log(`  whep post         ${ttff.post.toFixed(0)} ms`)
    console.log(`  first frame       ${ttff.frame.toFixed(0)} ms`)
    if (ttff.failed > 0) console.log(`  attempts failed   ${ttff.failed} of ${ATTEMPTS}`)
    check(
      'first frame',
      ttff.frame <= MAX_FIRST_FRAME_MS,
      `${ttff.frame.toFixed(0)} ms against a ${MAX_FIRST_FRAME_MS} ms target`,
    )
  }
}

// Without this the process lingers until idle_timeout (30s) — the pool holding a
// socket open is exactly what src/db/index.ts closes early for.
await sql.end()

if (failures.length > 0) {
  console.error(`\nmeasure: ${failures.length} check(s) failed — ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\nmeasure: all checks passed')
