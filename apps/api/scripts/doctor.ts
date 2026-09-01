import { type CameraConfig, cameraConfigs, maskRtsp } from '../src/camera'

// Setup-time pre-flight (docs/ARCHITECTURE.md#measurement). Probes both RTSP
// URLs of every configured camera with ffprobe, measures the real bitrate with ffmpeg, then makes the three
// calls that decide whether a deployment can work at all: an H.265 main stream
// will not play back in most browsers, a sub-stream that is not H.264 means live
// view needs transcoding this project deliberately does not do, and a bitrate
// that overruns the disk makes the configured retention a lie.
//
//   cd apps/api && bun run doctor
//
// Needs a camera and shells out to ffmpeg, so it stays manual and out of CI.
// Exits non-zero on any failed check, so it can gate a deployment.

import { getPath } from '../src/mediamtx/client'

// Long enough that a keyframe interval and a few seconds of motion are inside
// the sample. Two probes per camera run in parallel but cameras run in
// sequence, so seven cameras is a couple of minutes rather than fourteen
// simultaneous RTSP sessions against a server that is also recording.
const PROBE_SECONDS = 10
const PROBE_TIMEOUT_MS = 45_000

const REPO_ROOT = new URL('../../../', import.meta.url)
const MEDIAMTX_YML = new URL('mediamtx.yml', REPO_ROOT)
// The trailing slash is load-bearing: without it, resolving a camera's
// subdirectory against this URL replaces the last segment instead of descending
// into it, and the scan silently reads the wrong directory.
const RECORDINGS_DIR = new URL(
  `${(Bun.env.RECORDINGS_DIR ?? './recordings').replace(/\/+$/, '')}/`,
  REPO_ROOT,
)

// Unset and empty collapse into one failure, exactly as
// scripts/render-mediamtx.ts does: probing an empty URL fails in a way that
// looks like a broken camera rather than a missing setting.
const { cameras: configured, missing, errors } = cameraConfigs()

if (errors.length > 0) {
  console.error(`doctor: ${errors.join('\n        ')}`)
  process.exit(1)
}

if (missing.length > 0) {
  console.error(
    `doctor: missing or empty in .env — ${missing.join(', ')}\n` +
      'Run `cp .env.example .env` at the repo root and fill them in. It explains\n' +
      'how to ask the camera for its own stream URLs over ONVIF.',
  )
  process.exit(1)
}

for (const binary of ['ffprobe', 'ffmpeg']) {
  if (Bun.which(binary) === null) {
    console.error(`doctor: ${binary} not found on PATH. Install ffmpeg and re-run.`)
    process.exit(1)
  }
}

// Shared with render:mediamtx and seed so there is one implementation to
// audit. It redacts a password in userinfo AND md5(password) in the path: this
// script prints a URL every time it runs, and which of the two shapes a given
// camera uses is not something the operator should have to think about
// (docs/ARCHITECTURE.md#the-trust-boundary).
const mask = maskRtsp

type Command = { code: number; stdout: string; stderr: string }

async function run(binary: string, args: string[], timeoutMs: number): Promise<Command> {
  const proc = Bun.spawn([binary, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(timeoutMs),
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  return { code: await proc.exited, stdout, stderr }
}

// `${n}m`, `${n}h`, `${n}s` as MediaMTX writes them. Reads the FIRST match,
// which is the pathDefaults value - a per-camera override renders later in the
// file and is reported separately, because a fleet on mixed retention has no
// single number for this check to use.
function configSeconds(yml: string, key: string, fallback: number): number {
  const match = new RegExp(`^\\s*${key}:\\s*(\\d+)([smh])`, 'm').exec(yml)
  if (!match) return fallback

  const value = Number(match[1])
  const unit = match[2]
  return unit === 'h' ? value * 3600 : unit === 'm' ? value * 60 : value
}

type Stream = { codec: string; width: number; height: number; fps: number; bitrateBps: number }

async function probe(url: string): Promise<Stream | null> {
  // -rtsp_transport tcp is mandatory, not a preference: mediamtx.template.yml
  // sets `rtspTransports: [tcp]`, so a UDP probe simply never negotiates.
  const fields = 'codec_name,width,height,avg_frame_rate'
  const info = await run(
    'ffprobe',
    `-v error -rtsp_transport tcp -select_streams v:0 -show_entries stream=${fields} -of json`
      .split(' ')
      .concat('-i', url),
    PROBE_TIMEOUT_MS,
  )

  if (info.code !== 0) return null

  const parsed = JSON.parse(info.stdout) as {
    streams?: { codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }[]
  }
  const stream = parsed.streams?.[0]
  if (!stream?.codec_name) return null

  // avg_frame_rate is a rational — "30/1", and "0/0" for a stream ffprobe could
  // not average.
  const [num = '0', den = '1'] = (stream.avg_frame_rate ?? '0/1').split('/')
  const fps = Number(den) === 0 ? 0 : Number(num) / Number(den)

  return {
    codec: stream.codec_name,
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    fps,
    bitrateBps: await measureBitrate(url),
  }
}

// ffprobe's own bit_rate field is routinely absent on RTSP, so the bitrate is
// measured rather than asked for: copy the stream for PROBE_SECONDS and weigh
// what came out. -c copy means no decode, so this costs almost nothing.
async function measureBitrate(url: string): Promise<number> {
  const result = await run(
    'ffmpeg',
    '-hide_banner -loglevel info -rtsp_transport tcp -i'
      .split(' ')
      .concat(url, `-t ${PROBE_SECONDS} -c copy -f null -`.split(' ')),
    PROBE_TIMEOUT_MS,
  )

  // ffmpeg 7 writes `video:475kB`, ffmpeg 8 writes `video:475KiB`. Matching only
  // one of them silently reports a zero bitrate, which would pass the retention
  // check by looking free.
  const size = /video:\s*([\d.]+)\s*(Ki|k)B/i.exec(result.stderr)
  if (!size?.[1]) return 0

  const bytes = Number(size[1]) * (size[2]?.toLowerCase() === 'ki' ? 1024 : 1000)

  // The real elapsed stream time, not PROBE_SECONDS: ffmpeg stops on the first
  // packet past the cut, so the sample is usually a fraction of a second long.
  const clock = /time=(\d+):(\d\d):([\d.]+)/g
  const last = [...result.stderr.matchAll(clock)].at(-1)
  const seconds = last
    ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])
    : PROBE_SECONDS

  return seconds > 0 ? (bytes * 8) / seconds : 0
}

// No statvfs in Bun, and `df -P` is the POSIX-portable output format: available
// space is field 3 on both macOS and Linux.
async function freeBytes(dir: URL): Promise<number> {
  const result = await run('df', ['-Pk', Bun.fileURLToPath(dir)], 5_000)
  if (result.code !== 0) return 0

  const line = result.stdout.trim().split('\n').at(-1) ?? ''
  const available = line.split(/\s+/)[3]
  return available === undefined ? 0 : Number(available) * 1024
}

const GB = 1_000_000_000
const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`
const mbps = (bps: number) => `${(bps / 1_000_000).toFixed(2)} Mbps`

// Which URL is the main stream actually reachable at? Against real hardware
// MediaMTX pulls the camera and that is what to probe. In development the fake
// camera PUBLISHES to `yard` instead, so the camera URL answers nothing and
// probing it would report a broken deployment that is working fine. MediaMTX
// itself is the only honest source for which of the two is true.
async function mainStreamUrl(camera: CameraConfig): Promise<{ url: string; note: string }> {
  const pulled = { url: camera.main, note: 'pulled by MediaMTX from the camera' }

  try {
    const path = await getPath(camera.slug)
    if (path?.source && path.source.type !== 'rtspSource') {
      return {
        url: `rtsp://127.0.0.1:8554/${camera.slug}`,
        note: `published to MediaMTX by another process (${path.source.type}), not pulled`,
      }
    }
  } catch {
    // MediaMTX unreachable tells us nothing about the camera, and the camera is
    // what this script is for. Probe it and let the probe be the verdict.
  }

  return pulled
}

const describe = (stream: Stream | null) =>
  stream === null
    ? 'unreachable'
    : `${stream.codec}  ${stream.width}x${stream.height}  ${stream.fps.toFixed(0)}fps  ${mbps(stream.bitrateBps)}`

const failures: string[] = []
const warnings: string[] = []

// Three levels, not two. SPEC 10 calls the H.265 case a WARN and it is right
// to: HEVC playback is hardware-gated rather than absent, so the same recording
// plays in Chrome and Safari on a machine with a hardware decoder and fails on
// one without. Exiting non-zero for a setup that works on the operator's own
// machine would make `doctor` the thing that lies.
const report = (name: string, level: 'ok' | 'warn' | 'FAIL', detail: string) => {
  console.log(`  ${name.padEnd(24)}${level.padEnd(4)}  ${detail}`)
  if (level === 'FAIL') failures.push(name)
  if (level === 'warn') warnings.push(name)
}

const check = (name: string, ok: boolean, detail: string) =>
  report(name, ok ? 'ok' : 'FAIL', detail)

// Every camera's measured main-stream bitrate, because retention is a question
// about the SHARED disk and cannot be answered one camera at a time.
const mainStreams: (Stream | null)[] = []

for (const camera of configured) {
  const main = await mainStreamUrl(camera)

  console.log(`\ndoctor: ${camera.slug} — resolved stream URLs`)
  console.log(`  main      ${mask(main.url)}`)
  console.log(`            ${main.note}`)
  console.log(`  sub       ${mask(camera.sub)}`)
  console.log(`doctor: ${camera.slug} — probing both streams (${PROBE_SECONDS}s sample each)`)

  const [mainStream, subStream] = await Promise.all([probe(main.url), probe(camera.sub)])
  mainStreams.push(mainStream)

  console.log(`  main      ${describe(mainStream)}`)
  console.log(`  sub       ${describe(subStream)}`)

  // H.265 records smaller and plays back conditionally. Measured against Chrome
  // 152 on Apple silicon it plays fine — canPlayType says "probably", MSE
  // accepts it, and a 2304x1296 hvc1 clip decodes — because the machine has a
  // hardware HEVC decoder and Chrome will use it. Safari is the same. A browser
  // on hardware without one plays nothing, and Playwright's bundled Chromium
  // ships no HEVC at all, so an e2e suite pointed at H.265 footage would fail.
  //
  // So it is a warning about portability, not a broken install. The project
  // does not transcode (docs/ARCHITECTURE.md#what-this-deliberately-does-not-do);
  // the escape hatch is recording the H.264 sub-stream instead.
  report(
    `${camera.slug} main codec`,
    mainStream === null ? 'FAIL' : mainStream.codec === 'hevc' ? 'warn' : 'ok',
    mainStream === null
      ? `main stream unreachable — check CAMERA_${camera.slug.toUpperCase()}_RTSP_MAIN, then re-run render:mediamtx`
      : mainStream.codec === 'hevc'
        ? 'H.265 needs a hardware decoder — plays in Chrome/Safari on this Mac, not everywhere'
        : `${mainStream.codec} plays in every target browser`,
  )

  check(
    `${camera.slug} sub codec`,
    subStream !== null && subStream.codec === 'h264',
    subStream === null
      ? `sub-stream unreachable — live view has nothing to read (check CAMERA_${camera.slug.toUpperCase()}_RTSP_SUB)`
      : subStream.codec === 'h264'
        ? 'h264, so live view needs no transcode'
        : `${subStream.codec} would need transcoding, which this project does not do`,
  )
}

console.log('\ndoctor: checks')

// One fleet-level verdict, not one per camera. Every camera writes to the same
// disk, so seven per-camera checks would each pass comfortably while the fleet
// overran it — which is the exact failure this check exists to catch. Same
// reasoning as routes/health.ts, which sums bytesWritten24h across cameras
// before projecting daysRemaining.
//
// Main streams only: the sub-streams are `record: no` and cost nothing on disk.
const yml = (await Bun.file(MEDIAMTX_YML).exists()) ? await Bun.file(MEDIAMTX_YML).text() : ''
const retentionDays = configSeconds(yml, 'recordDeleteAfter', 168 * 3600) / 86_400
const free = await freeBytes(RECORDINGS_DIR)
const bytesPerDay = mainStreams.reduce(
  (total, stream) => total + ((stream?.bitrateBps ?? 0) / 8) * 86_400,
  0,
)
const daysUntilFull = bytesPerDay > 0 ? free / bytesPerDay : Infinity

// Which camera dominates is the actionable half of the number.
for (const [index, stream] of mainStreams.entries()) {
  if (stream === null) continue
  const slug = configured[index]?.slug ?? '?'
  console.log(`  ${`${slug} writes`.padEnd(24)}      ${gb((stream.bitrateBps / 8) * 86_400)}/day`)
}

const overrides = configured.filter((camera) => camera.deleteAfter !== null)

check(
  'retention fits',
  bytesPerDay > 0 && daysUntilFull >= retentionDays,
  bytesPerDay === 0
    ? 'no measured bitrate, so retention cannot be projected'
    : `${configured.length} cameras write ${gb(bytesPerDay)}/day, ${gb(free)} free = ${daysUntilFull.toFixed(1)} days;` +
        ` recordDeleteAfter keeps ${retentionDays.toFixed(0)}` +
        (overrides.length === 0
          ? ''
          : ` (${overrides.map((camera) => `${camera.slug} ${camera.deleteAfter}`).join(', ')} override it)`) +
        (daysUntilFull >= retentionDays ? '' : ' — the disk fills before retention expires'),
)

const noted = warnings.length > 0 ? ` (${warnings.length} warning: ${warnings.join(', ')})` : ''

if (failures.length > 0) {
  console.error(`\ndoctor: ${failures.length} check(s) failed — ${failures.join(', ')}${noted}`)
  process.exit(1)
}

// Warnings do not fail the run. They are things to know, not things to fix
// before the system can be trusted to record.
console.log(`\ndoctor: all checks passed${noted}`)
