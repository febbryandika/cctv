// Renders mediamtx.yml from mediamtx.template.yml
// (docs/ARCHITECTURE.md#the-media-pipeline).
//
// The BARDI-family RTSP path is
// rtsp://<ip>:5543/<md5(ONVIF_PASSWORD)>/live/channel0, so the rendered config
// contains a password hash (docs/ARCHITECTURE.md#the-trust-boundary). That is
// why mediamtx.yml is generated and gitignored while the template is tracked:
// nothing that embeds the hash is ever committable.
//
//   cd apps/api && bun run render:mediamtx
//
// Paths resolve from import.meta.url, not cwd, so this works from anywhere.

const TEMPLATE = new URL('../../../mediamtx.template.yml', import.meta.url)
const OUTPUT = new URL('../../../mediamtx.yml', import.meta.url)

const BANNER = `# GENERATED FILE — DO NOT EDIT, DO NOT COMMIT.
#
# Rendered from mediamtx.template.yml by apps/api/scripts/render-mediamtx.ts:
#
#     cd apps/api && bun run render:mediamtx
#
# This file embeds md5(ONVIF_PASSWORD), so a leaked copy leaks a password hash
# (docs/ARCHITECTURE.md#the-trust-boundary) — hence gitignored. Edit the
# template and re-render; anything
# changed here is lost on the next run. Re-render after editing CAMERA_IP or
# ONVIF_PASSWORD in .env.

`

// ?? '' collapses unset and empty into one failure. md5('') is
// d41d8cd98f00b204e9800998ecf8427e — a real-looking hash for a missing
// password, which would start cleanly and never connect to the camera.
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
    `render:mediamtx: missing or empty in .env — ${missing.join(', ')}\n` +
      'Run `cp .env.example .env` at the repo root and fill them in. Rendering a\n' +
      'placeholder instead would produce a config that starts cleanly and never\n' +
      'connects, which is the failure this script exists to prevent.',
  )
  process.exit(1)
}

const onvifPasswordMd5 = new Bun.CryptoHasher('md5').update(onvifPassword).digest('hex')

// The sub-stream source is a token rather than a literal because development has
// no camera to pull channel1 from, and MediaMTX cannot be told otherwise: an
// MTX_PATHS_* override cannot address a path whose name contains an underscore
// (it splits the name on `_`), so MTX_PATHS_YARD_SUB_SOURCE is parsed as path
// `yard` key `sub_source`, silently discarded with no warning. Verified against
// v1.20.1: an equivalent `yardsub` path takes the override and `yard_sub` does
// not, and neither `__` nor lowercase escapes it.
//
// So the substitution happens here instead. Unset means the real camera, which
// is what an existing .env renders — byte-identically to before this token
// existed. .env.example sets it to rtsp://localhost:8554/yard, which makes
// MediaMTX relay its own `yard` path on demand: no second ffmpeg, and
// sourceOnDemand still holds, so the sub-stream is dialled only while a browser
// is actually watching.
const yardSubSource =
  Bun.env.YARD_SUB_SOURCE || `rtsp://${cameraIp}:5543/${onvifPasswordMd5}/live/channel1`

const vars: Record<string, string> = {
  CAMERA_IP: cameraIp,
  // Lowercase hex (docs/ARCHITECTURE.md#the-media-pipeline).
  ONVIF_PASSWORD_MD5: onvifPasswordMd5,
  YARD_SUB_SOURCE: yardSubSource,
}

const template = await Bun.file(TEMPLATE).text()

const unknown = new Set<string>()
const body = template.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
  const value = vars[name]
  if (value === undefined) {
    unknown.add(name)
    return ''
  }
  return value
})

if (unknown.size > 0) {
  console.error(
    `render:mediamtx: mediamtx.template.yml uses unknown token(s) — ${[...unknown].join(', ')}`,
  )
  process.exit(1)
}

const rendered = BANNER + body

const output = Bun.file(OUTPUT)
const current = (await output.exists()) ? await output.text() : null

if (current === rendered) {
  console.log('mediamtx.yml: already up to date')
} else {
  await Bun.write(OUTPUT, rendered)
  console.log('mediamtx.yml: written from mediamtx.template.yml')
}

// Masked, like `doctor` (docs/ARCHITECTURE.md#measurement,
// #the-trust-boundary): enough to confirm the IP and the shape, never the hash.
// The mask is a regex rather than a fixed string because yard_sub's source is
// now configurable and may or may not embed the hash.
const mask = (url: string) => url.replace(/[0-9a-f]{32}/g, '•'.repeat(8))

console.log(`  yard      ${mask(`rtsp://${cameraIp}:5543/${onvifPasswordMd5}/live/channel0`)}`)
console.log(`  yard_sub  ${mask(yardSubSource)}`)
