import { describe, expect, it } from 'vitest'
import { maskRtsp } from './camera'

// A stream URL is a credential (docs/ARCHITECTURE.md#the-trust-boundary), and
// `doctor` prints one every time it runs. These are the shapes it has to be
// safe against — the secret can be a password in userinfo or a hash in the
// path, and the point of the mask is that neither survives.
describe('maskRtsp', () => {
  it('redacts a password in userinfo and keeps the username', () => {
    expect(maskRtsp('rtsp://admin:s3cr3t@192.168.1.112:554/V_ENC_000')).toBe(
      'rtsp://admin:••••••@192.168.1.112:554/V_ENC_000',
    )
  })

  it('redacts md5(password) in the path', () => {
    expect(
      maskRtsp('rtsp://192.168.1.112:5543/5f4dcc3b5aa765d61d8327deb882cf99/live/channel0'),
    ).toBe('rtsp://192.168.1.112:5543/••••••••/live/channel0')
  })

  it('redacts a bare token in userinfo, with no colon', () => {
    expect(maskRtsp('rtsp://t0ken@10.0.0.5:554/stream')).toBe('rtsp://••••••@10.0.0.5:554/stream')
  })

  it('leaves a URL with no secret in it alone', () => {
    expect(maskRtsp('rtsp://localhost:8554/yard')).toBe('rtsp://localhost:8554/yard')
  })

  // The path is the useful half of the output — "which stream is this?" — and
  // an over-eager mask that ate it would make doctor useless for the thing it
  // exists to diagnose.
  it('keeps host, port and path readable', () => {
    expect(maskRtsp('rtsp://user:pw@cam.local:8554/live/ch1')).toContain('cam.local:8554/live/ch1')
  })

  // 32 hex characters anywhere in the path is treated as a hash. A path segment
  // that merely LOOKS like one is redacted too, which is the safe direction to
  // be wrong in.
  it('does not mistake a short hex segment for a hash', () => {
    expect(maskRtsp('rtsp://cam:554/abc123/live')).toBe('rtsp://cam:554/abc123/live')
  })
})
