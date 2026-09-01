// The cameras: where each one is, and how to print one without leaking it.
//
// Stream URLs are configured explicitly rather than derived from an IP and a
// password. The project used to build them from one hardcoded shape —
// rtsp://<ip>:5543/<md5(ONVIF_PASSWORD)>/live/channelN — which is what the
// reference camera's vendor documentation described and what the first camera
// tested against actually used. A second camera of the same family did not:
// it serves rtsp://<user>:<pass>@<ip>:554/V_ENC_000, on the standard port,
// with credentials in userinfo and no hash anywhere.
//
// One template cannot cover both, and guessing wrong fails in the worst
// possible way — a config that renders cleanly and silently never connects.
// The operator pastes what their camera actually reports instead. Every ONVIF
// camera will tell you, via GetStreamUri on its device service; .env.example
// spells out how to ask.
//
// process.env, not Bun.env: apps/web typechecks this directory through the
// type-only AppType import (docs/ARCHITECTURE.md#the-api-surface) and has no
// @types/bun, so a Bun global here fails the web CI job pointing at a file in
// this app.

export type CameraConfig = {
  /** MediaMTX path name, recordings/ directory, and `cameras.slug`. */
  slug: string
  /** The operator's label. Never used as an identifier. */
  name: string
  /** Recorded continuously. */
  main: string
  /** Live view only, so watching can never disturb the recording. */
  sub: string
  /**
   * Per-path retention override, or null to inherit `pathDefaults`.
   *
   * Retention lives in `pathDefaults`, so one fleet-wide value applies to every
   * camera including the one that already has an archive on disk. That is the
   * whole reason this exists: seven fake cameras can run at 12h against a
   * laptop disk while a real camera keeps its week, without the short value
   * reaping footage that took a week to accumulate.
   */
  deleteAfter: string | null
}

/** MediaMTX durations — an integer and a unit. Notably no `d`. */
const DURATION = /^\d+[smh]$/

/**
 * A camera slug.
 *
 * Deliberately narrower than the route validators, because a slug has to
 * survive three different namings and this is the only place that can enforce
 * all three at once:
 *
 *   - it is a MediaMTX path name, and MediaMTX splits path names on `_` — which
 *     is why MTX_PATHS_YARD_SUB_SOURCE silently addresses path `yard`, key
 *     `sub_source` (mediamtx.template.yml, verified against v1.20.1);
 *   - it is the middle of an environment variable name, which admits neither a
 *     dash nor a case distinction;
 *   - it is a directory under recordings/, and renaming it later means moving
 *     footage and rewriting stream_events and daily_coverage by hand, because
 *     both foreign keys are ON DELETE CASCADE rather than ON UPDATE.
 */
const SLUG = /^[a-z][a-z0-9]*$/

const envName = (slug: string, suffix: string) => `CAMERA_${slug.toUpperCase()}_${suffix}`

/**
 * Every camera in `CAMERAS`, in the order the operator listed them.
 *
 * Problems are returned rather than thrown, in two kinds, because they want
 * different words in front of them: `errors` is a list that cannot be read at
 * all, `missing` is the names of variables that were never set. Callers print
 * both and exit.
 *
 * Empty and unset collapse into one failure on purpose: a half-configured
 * camera is not a working one, and an empty string would render a URL that
 * looks plausible and never connects.
 */
export function cameraConfigs(env: Record<string, string | undefined> = process.env): {
  cameras: CameraConfig[]
  missing: string[]
  errors: string[]
} {
  const cameras: CameraConfig[] = []
  const missing: string[] = []
  const errors: string[] = []

  const slugs = (env.CAMERAS ?? '')
    .split(',')
    .map((slug) => slug.trim())
    .filter((slug) => slug !== '')

  if (slugs.length === 0) {
    // The single-camera .env is a real thing on a real machine, so name the
    // rename rather than leaving an operator to diff .env.example.
    errors.push(
      env.CAMERA_RTSP_MAIN === undefined
        ? 'CAMERAS is unset or empty — list the camera slugs, e.g. CAMERAS=yard,cam2'
        : 'CAMERAS is unset, but CAMERA_RTSP_MAIN is set. This .env predates multi-camera: ' +
            'rename CAMERA_RTSP_MAIN to CAMERA_YARD_RTSP_MAIN and CAMERA_RTSP_SUB to ' +
            'CAMERA_YARD_RTSP_SUB, add CAMERAS=yard, and drop MTX_PATHS_YARD_SOURCE ' +
            '(each camera source now comes from its own variable).',
    )
    return { cameras, missing, errors }
  }

  const seen = new Set<string>()

  for (const slug of slugs) {
    if (!SLUG.test(slug)) {
      errors.push(
        `CAMERAS: ${slug} is not a usable slug — lowercase letters and digits only, starting with a letter (no _, no -)`,
      )
      continue
    }

    if (seen.has(slug)) {
      errors.push(`CAMERAS: ${slug} is listed twice`)
      continue
    }
    seen.add(slug)

    const main = env[envName(slug, 'RTSP_MAIN')] ?? ''
    const sub = env[envName(slug, 'RTSP_SUB')] ?? ''

    if (main === '') missing.push(envName(slug, 'RTSP_MAIN'))
    if (sub === '') missing.push(envName(slug, 'RTSP_SUB'))

    // A URL cannot contain whitespace (RFC 3986), so whitespace is a typo — a
    // trailing space, or a value that wrapped across lines. Caught here because
    // both reach the rendered YAML otherwise, where a newline stops being a typo
    // and starts being injected configuration.
    for (const [name, value] of [
      [envName(slug, 'RTSP_MAIN'), main],
      [envName(slug, 'RTSP_SUB'), sub],
    ] as const) {
      if (value !== '' && /\s/.test(value)) {
        errors.push(`${name}: contains whitespace — check for a trailing space or a wrapped line`)
      }
    }

    const deleteAfter = env[envName(slug, 'RECORD_DELETE_AFTER')]
    if (deleteAfter !== undefined && !DURATION.test(deleteAfter)) {
      errors.push(
        `${envName(slug, 'RECORD_DELETE_AFTER')}: ${deleteAfter || '(empty)'} is not a MediaMTX duration — an integer and s, m or h, e.g. 168h`,
      )
    }

    cameras.push({
      slug,
      // A label is nice to have and never load-bearing, so an unset one is a
      // default rather than a failure — unlike a URL, a wrong label cannot cost
      // you footage.
      name: env[envName(slug, 'NAME')] || slug[0]!.toUpperCase() + slug.slice(1),
      main,
      sub,
      deleteAfter: deleteAfter !== undefined && DURATION.test(deleteAfter) ? deleteAfter : null,
    })
  }

  return { cameras, missing, errors }
}

/**
 * A single-quoted YAML scalar.
 *
 * The old template interpolated stream URLs bare and got away with it. Seven
 * URLs pasted from seven admin pages is a different risk: a `#` in a password
 * would start a comment and truncate the source, and MediaMTX would start
 * cleanly on a config that connects to nothing.
 */
const yamlString = (value: string) => `'${value.replaceAll("'", "''")}'`

/**
 * The `paths:` block of mediamtx.yml — two paths per camera.
 *
 * This lives here rather than in scripts/render-mediamtx.ts because
 * vitest.config.ts covers src/** and never scripts/, and the rendered config is
 * the one artefact in this project where a silent mistake costs a day of
 * footage rather than a stack trace.
 */
export function renderPaths(cameras: CameraConfig[]): string {
  return cameras
    .map(
      (camera) =>
        // Main stream: high resolution, recorded continuously, never watched
        // directly — so a viewer can never disturb the recording. %path is what
        // gives each camera its own directory, which is what lets
        // timeline/disk.ts resolve `<slug>/` and get that camera's bytes.
        `  ${camera.slug}:\n` +
        `    source: ${yamlString(camera.main)}\n` +
        `    sourceOnDemand: no # must record whether or not anyone is watching\n` +
        `    record: yes\n` +
        `    recordPath: ./recordings/%path/%Y-%m-%d_%H-%M-%S-%f\n` +
        // Only when overridden: an inherited value is pathDefaults' job, and
        // writing it out per path would turn one number to change into N.
        (camera.deleteAfter === null ? '' : `    recordDeleteAfter: ${camera.deleteAfter}\n`) +
        `\n` +
        // Sub-stream: low bitrate, H.264, pulled only while a browser is
        // connected. sourceOnDemand also keeps it quiet in development — it is
        // never dialled until something watches, so it does not spam connection
        // errors the way a `no` would.
        `  ${camera.slug}_sub:\n` +
        `    source: ${yamlString(camera.sub)}\n` +
        `    sourceOnDemand: yes\n` +
        `    record: no\n`,
    )
    .join('\n')
}

/**
 * An RTSP URL with its secret removed, safe to print or log.
 *
 * A stream URL is a credential (docs/ARCHITECTURE.md#the-trust-boundary), and
 * it can carry one in either of two places: as a password in userinfo, or as
 * md5(password) in the path. Both are redacted. The username, host, port and
 * path survive, because those are exactly what somebody debugging a camera
 * needs to read back.
 */
export const maskRtsp = (url: string): string =>
  url
    .replace(/(:\/\/[^/:@]*:)[^@/]*@/, '$1••••••@')
    .replace(/(:\/\/)[^/:@]*@/, '$1••••••@')
    .replace(/[0-9a-f]{32}/gi, '•'.repeat(8))
