import { cameraConfigs, maskRtsp, renderPaths } from '../src/camera'

// Renders mediamtx.yml from mediamtx.template.yml
// (docs/ARCHITECTURE.md#the-media-pipeline).
//
// The rendered config contains the camera's stream URLs, and a stream URL is a
// credential — it carries either a password in userinfo or md5(password) in the
// path (docs/ARCHITECTURE.md#the-trust-boundary). That is why mediamtx.yml is
// generated and gitignored while the template is tracked: nothing that embeds a
// secret is ever committable.
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
# This file embeds the camera's stream URLs, which carry its credentials
# (docs/ARCHITECTURE.md#the-trust-boundary) — hence gitignored. Edit the
# template and re-render; anything changed here is lost on the next run.
# Re-render after editing CAMERAS or any CAMERA_<SLUG>_* variable in .env, then
# \`docker compose restart mediamtx\` to make MediaMTX read it.

`

// Unset and empty collapse into one failure: an empty source renders a config
// that starts cleanly and never connects, which is the failure this script
// exists to prevent.
const { cameras, missing, errors } = cameraConfigs()

if (errors.length > 0) {
  console.error(`render:mediamtx: ${errors.join('\n                 ')}`)
  process.exit(1)
}

if (missing.length > 0) {
  console.error(
    `render:mediamtx: missing or empty in .env — ${missing.join(', ')}\n` +
      'Run `cp .env.example .env` at the repo root and fill them in. It explains\n' +
      'how to ask the camera for its own stream URLs over ONVIF, which is more\n' +
      'reliable than guessing at a vendor path.',
  )
  process.exit(1)
}

// Time-based, per path, with no global size cap and nothing that evicts under
// pressure — so this number times the number of cameras has to fit the disk.
// Raise it only against a measured bytesPerHour from /health, never a datasheet
// (docs/ARCHITECTURE.md#observability).
const deleteAfter = process.env.RECORD_DELETE_AFTER ?? '168h'

if (!/^\d+[smh]$/.test(deleteAfter)) {
  console.error(
    `render:mediamtx: RECORD_DELETE_AFTER=${deleteAfter} is not a MediaMTX duration — ` +
      'an integer and s, m or h, e.g. 168h. There is no `d`.',
  )
  process.exit(1)
}

const vars: Record<string, string> = {
  CAMERA_PATHS: renderPaths(cameras),
  RECORD_DELETE_AFTER: deleteAfter,
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
// #the-trust-boundary): enough to confirm the host and the path, never the
// secret. Shared with doctor and seed so there is one implementation to audit.
const overridden = cameras.filter((camera) => camera.deleteAfter !== null)
console.log(
  `  ${cameras.length} cameras, recordDeleteAfter ${deleteAfter}` +
    (overridden.length === 0
      ? ''
      : ` (${overridden.map((camera) => `${camera.slug} ${camera.deleteAfter}`).join(', ')})`),
)

// Wide enough for the longest `<slug>_sub`, not the longest slug.
const width = Math.max(...cameras.map((camera) => camera.slug.length)) + 6
for (const camera of cameras) {
  console.log(`  ${camera.slug.padEnd(width)}${maskRtsp(camera.main)}`)
  console.log(`  ${`${camera.slug}_sub`.padEnd(width)}${maskRtsp(camera.sub)}`)
}
