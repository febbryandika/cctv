// Renders mediamtx.yml from mediamtx.template.yml (SPEC 7).
//
// The BARDI-family RTSP path is rtsp://<ip>:5543/<md5(ONVIF_PASSWORD)>/live/channel0,
// so the rendered config contains a password hash (SPEC 15). That is why
// mediamtx.yml is generated and gitignored while the template is tracked:
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
# (SPEC 15) — hence gitignored. Edit the template and re-render; anything
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

const vars: Record<string, string> = {
  CAMERA_IP: cameraIp,
  // Lowercase hex, per SPEC 7.
  ONVIF_PASSWORD_MD5: new Bun.CryptoHasher('md5').update(onvifPassword).digest('hex'),
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

// Masked, like `doctor` (SPEC 10, 15): enough to confirm the IP and the shape,
// never the hash.
console.log(`  yard      rtsp://${cameraIp}:5543/${'•'.repeat(8)}/live/channel0`)
console.log(`  yard_sub  rtsp://${cameraIp}:5543/${'•'.repeat(8)}/live/channel1`)
