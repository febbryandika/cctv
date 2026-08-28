// The camera's RTSP URLs, and how to print one without leaking it.
//
// These are configured explicitly rather than derived from an IP and a
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

/**
 * Both stream URLs, plus the names of any that are missing.
 *
 * Empty and unset collapse into one failure on purpose: a half-configured
 * camera is not a working one, and an empty string would render a URL that
 * looks plausible and never connects.
 */
export function cameraUrls(): { main: string; sub: string; missing: string[] } {
  const main = process.env.CAMERA_RTSP_MAIN ?? ''
  const sub = process.env.CAMERA_RTSP_SUB ?? ''

  return {
    main,
    sub,
    missing: (
      [
        ['CAMERA_RTSP_MAIN', main],
        ['CAMERA_RTSP_SUB', sub],
      ] as const
    )
      .filter(([, value]) => value === '')
      .map(([name]) => name),
  }
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
