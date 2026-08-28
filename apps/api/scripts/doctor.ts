// Setup-time pre-flight (docs/ARCHITECTURE.md#measurement). Probes both RTSP
// URLs with ffprobe, measures the real bitrate with ffmpeg, then makes the three
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
// the sample; short enough that the whole run stays under a minute.
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

// The camera family this targets serves rtsp://<ip>:5543/<md5(password)>/live/channelN
// (docs/ARCHITECTURE.md#the-media-pipeline), so the path itself is a secret.
const CAMERA_RTSP_PORT = 5543

// ?? '' collapses unset and empty into one failure, exactly as
// scripts/render-mediamtx.ts does: md5('') is a real-looking hash, so a missing
// password produces a URL that looks right and never connects.
const cameraIp = Bun.env.CAMERA_IP ?? ''
const onvifPassword = Bun.env.ONVIF_PASSWORD ?? ''

const missing = (
  [
    ['CAMERA_IP', cameraIp],
    ['ONVIF_PASSWORD', onvifPassword],
  ] as const
)
  .filter(([, value]) => value === '')
  .map(([name]) => name)

if (missing.length > 0) {
  console.error(
    `doctor: missing or empty in .env — ${missing.join(', ')}\n` +
      'Run `cp .env.example .env` at the repo root and fill them in. Probing a\n' +
      'placeholder URL would fail in a way that looks like a broken camera.',
  )
  process.exit(1)
}

for (const binary of ['ffprobe', 'ffmpeg']) {
  if (Bun.which(binary) === null) {
    console.error(`doctor: ${binary} not found on PATH. Install ffmpeg and re-run.`)
    process.exit(1)
  }
}

const onvifPasswordMd5 = new Bun.CryptoHasher('md5').update(onvifPassword).digest('hex')
const cameraUrl = (channel: 0 | 1) =>
  `rtsp://${cameraIp}:${CAMERA_RTSP_PORT}/${onvifPasswordMd5}/live/channel${channel}`

// Regex rather than a fixed string because the sub-stream source is configurable
// and may or may not embed the hash (docs/ARCHITECTURE.md#the-trust-boundary).
// Enough to confirm the IP and the shape, never the hash itself.
const mask = (url: string) => url.replace(/[0-9a-f]{32}/g, '•'.repeat(8))

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

// `${n}m`, `${n}h`, `${n}s` as MediaMTX writes them. The trailing-comment guard
// matters: the rendered config carries `recordDeleteAfter: 168h # 7 days`.
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
async function mainStreamUrl(): Promise<{ url: string; note: string }> {
  const camera = { url: cameraUrl(0), note: 'pulled by MediaMTX from the camera' }

  try {
    const path = await getPath('yard')
    if (path?.source && path.source.type !== 'rtspSource') {
      return {
        url: 'rtsp://127.0.0.1:8554/yard',
        note: `published to MediaMTX by another process (${path.source.type}), not pulled`,
      }
    }
  } catch {
    // MediaMTX unreachable tells us nothing about the camera, and the camera is
    // what this script is for. Probe it and let the probe be the verdict.
  }

  return camera
}

const subUrl = Bun.env.YARD_SUB_SOURCE || cameraUrl(1)
const main = await mainStreamUrl()

console.log('doctor: resolved stream URLs')
console.log(`  main      ${mask(main.url)}`)
console.log(`            ${main.note}`)
console.log(`  sub       ${mask(subUrl)}`)
console.log(`\ndoctor: probing both streams (${PROBE_SECONDS}s sample each)`)

const [mainStream, subStream] = await Promise.all([probe(main.url), probe(subUrl)])

const describe = (stream: Stream | null) =>
  stream === null
    ? 'unreachable'
    : `${stream.codec}  ${stream.width}x${stream.height}  ${stream.fps.toFixed(0)}fps  ${mbps(stream.bitrateBps)}`

console.log(`  main      ${describe(mainStream)}`)
console.log(`  sub       ${describe(subStream)}`)

const failures: string[] = []
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${name.padEnd(18)}${ok ? 'ok  ' : 'FAIL'}  ${detail}`)
  if (!ok) failures.push(name)
}

console.log('\ndoctor: checks')

// H.265 records smaller and plays in almost nothing. The project does not
// transcode (docs/ARCHITECTURE.md#what-this-deliberately-does-not-do), so the
// answer is to record the H.264 sub-stream, or accept an archive nobody can view.
check(
  'main codec',
  mainStream !== null && mainStream.codec !== 'hevc',
  mainStream === null
    ? 'main stream unreachable — check CAMERA_IP and ONVIF_PASSWORD, then re-run render:mediamtx'
    : mainStream.codec === 'hevc'
      ? 'H.265 will not play back in most browsers — record the sub-stream instead'
      : `${mainStream.codec} plays in every target browser`,
)

check(
  'sub codec',
  subStream !== null && subStream.codec === 'h264',
  subStream === null
    ? 'sub-stream unreachable — live view has nothing to read (check YARD_SUB_SOURCE)'
    : subStream.codec === 'h264'
      ? 'h264, so live view needs no transcode'
      : `${subStream.codec} would need transcoding, which this project does not do`,
)

// A retention setting nobody checked against a real bitrate is a guess.
const yml = (await Bun.file(MEDIAMTX_YML).exists()) ? await Bun.file(MEDIAMTX_YML).text() : ''
const retentionDays = configSeconds(yml, 'recordDeleteAfter', 168 * 3600) / 86_400
const free = await freeBytes(RECORDINGS_DIR)
const bytesPerDay = ((mainStream?.bitrateBps ?? 0) / 8) * 86_400
const daysUntilFull = bytesPerDay > 0 ? free / bytesPerDay : Infinity

check(
  'retention fits',
  bytesPerDay > 0 && daysUntilFull >= retentionDays,
  bytesPerDay === 0
    ? 'no measured bitrate, so retention cannot be projected'
    : `${gb(bytesPerDay)}/day, ${gb(free)} free = ${daysUntilFull.toFixed(1)} days;` +
        ` recordDeleteAfter keeps ${retentionDays.toFixed(0)}` +
        (daysUntilFull >= retentionDays ? '' : ' — the disk fills before retention expires'),
)

if (failures.length > 0) {
  console.error(`\ndoctor: ${failures.length} check(s) failed — ${failures.join(', ')}`)
  process.exit(1)
}

console.log('\ndoctor: all checks passed')
