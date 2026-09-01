import { describe, expect, it } from 'vitest'
import { cameraConfigs, maskRtsp, renderPaths } from './camera'

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

// The camera list. This is the only new pure logic in the seven-camera change,
// and it is where a wrong answer is quiet: a slug that MediaMTX cannot address,
// or a URL that is missing rather than wrong, both render a config that starts
// cleanly and never connects.
describe('cameraConfigs', () => {
  const env = (over: Record<string, string>) => ({
    CAMERAS: 'yard',
    CAMERA_YARD_RTSP_MAIN: 'rtsp://cam/main',
    CAMERA_YARD_RTSP_SUB: 'rtsp://cam/sub',
    ...over,
  })

  it('reads one camera', () => {
    const { cameras, missing, errors } = cameraConfigs(env({}))

    expect(errors).toEqual([])
    expect(missing).toEqual([])
    expect(cameras).toEqual([
      {
        slug: 'yard',
        name: 'Yard',
        main: 'rtsp://cam/main',
        sub: 'rtsp://cam/sub',
        deleteAfter: null,
      },
    ])
  })

  // CAMERAS is ordered, and that order is what the operator sees in the live
  // grid and the recordings picker. Alphabetising it here would silently
  // override a deliberate arrangement.
  it('preserves the order of CAMERAS', () => {
    const { cameras } = cameraConfigs({
      CAMERAS: 'cam3,yard,cam2',
      CAMERA_CAM3_RTSP_MAIN: 'a',
      CAMERA_CAM3_RTSP_SUB: 'b',
      CAMERA_YARD_RTSP_MAIN: 'c',
      CAMERA_YARD_RTSP_SUB: 'd',
      CAMERA_CAM2_RTSP_MAIN: 'e',
      CAMERA_CAM2_RTSP_SUB: 'f',
    })

    expect(cameras.map((camera) => camera.slug)).toEqual(['cam3', 'yard', 'cam2'])
  })

  it('tolerates whitespace and trailing commas in the list', () => {
    const { cameras, errors } = cameraConfigs(env({ CAMERAS: ' yard , ' }))

    expect(errors).toEqual([])
    expect(cameras.map((camera) => camera.slug)).toEqual(['yard'])
  })

  it('defaults the display name to the capitalised slug', () => {
    expect(
      cameraConfigs(env({ CAMERAS: 'cam2', CAMERA_CAM2_RTSP_MAIN: 'a', CAMERA_CAM2_RTSP_SUB: 'b' }))
        .cameras[0]?.name,
    ).toBe('Cam2')
  })

  it('uses CAMERA_<SLUG>_NAME when it is set', () => {
    expect(cameraConfigs(env({ CAMERA_YARD_NAME: 'Back yard' })).cameras[0]?.name).toBe('Back yard')
  })

  it('reports an unset CAMERAS rather than returning nothing quietly', () => {
    const { cameras, errors } = cameraConfigs({})

    expect(cameras).toEqual([])
    expect(errors.join(' ')).toContain('CAMERAS')
  })

  // A live single-camera .env is a real thing on a real machine; the error is
  // the only migration instruction its operator will see.
  it('names the rename when the .env predates multi-camera', () => {
    const { errors } = cameraConfigs({ CAMERA_RTSP_MAIN: 'rtsp://cam/main' })

    expect(errors.join(' ')).toContain('CAMERA_YARD_RTSP_MAIN')
  })

  it('reports an empty CAMERAS the same way', () => {
    expect(cameraConfigs({ CAMERAS: '  ' }).errors.join(' ')).toContain('CAMERAS')
  })

  // The slug becomes a MediaMTX path name, a directory under recordings/, and
  // the middle of an environment variable name. An underscore breaks the first
  // (MediaMTX splits path names on `_`), a dash breaks the third, and an
  // uppercase letter breaks the mapping both ways.
  it.each(['front_gate', 'front-gate', 'Yard', '2cam', 'yard!', 'yard sub'])(
    'rejects the slug %o',
    (slug) => {
      const { cameras, errors } = cameraConfigs(env({ CAMERAS: `yard,${slug}` }))

      expect(cameras.map((camera) => camera.slug)).not.toContain(slug)
      expect(errors.length).toBeGreaterThan(0)
    },
  )

  it('names the offending slug in the error', () => {
    expect(cameraConfigs(env({ CAMERAS: 'front_gate' })).errors.join(' ')).toContain('front_gate')
  })

  it('rejects a duplicate slug', () => {
    const { cameras, errors } = cameraConfigs(env({ CAMERAS: 'yard,yard' }))

    expect(cameras).toHaveLength(1)
    expect(errors.join(' ')).toContain('yard')
  })

  // Empty and unset collapse into one failure, exactly as the single-camera
  // version did: a half-configured camera is not a working one, and an empty
  // string renders a URL that looks plausible and never connects.
  it('reports a missing main URL by variable name', () => {
    expect(cameraConfigs(env({ CAMERA_YARD_RTSP_MAIN: '' })).missing).toEqual([
      'CAMERA_YARD_RTSP_MAIN',
    ])
  })

  it('reports a missing sub URL by variable name', () => {
    const { missing } = cameraConfigs({ CAMERAS: 'cam2', CAMERA_CAM2_RTSP_MAIN: 'a' })

    expect(missing).toEqual(['CAMERA_CAM2_RTSP_SUB'])
  })

  it('reports every missing variable across every camera, not just the first', () => {
    const { missing } = cameraConfigs({ CAMERAS: 'yard,cam2' })

    expect(missing).toEqual([
      'CAMERA_YARD_RTSP_MAIN',
      'CAMERA_YARD_RTSP_SUB',
      'CAMERA_CAM2_RTSP_MAIN',
      'CAMERA_CAM2_RTSP_SUB',
    ])
  })

  it('reads seven cameras', () => {
    const slugs = ['yard', 'cam2', 'cam3', 'cam4', 'cam5', 'cam6', 'cam7']
    const seven: Record<string, string> = { CAMERAS: slugs.join(',') }
    for (const slug of slugs) {
      seven[`CAMERA_${slug.toUpperCase()}_RTSP_MAIN`] = `rtsp://cam/${slug}`
      seven[`CAMERA_${slug.toUpperCase()}_RTSP_SUB`] = `rtsp://localhost:8554/${slug}`
    }

    const { cameras, missing, errors } = cameraConfigs(seven)

    expect(errors).toEqual([])
    expect(missing).toEqual([])
    expect(cameras).toHaveLength(7)
  })
})

// The paths block MediaMTX actually runs on. render-mediamtx.ts is a script and
// vitest.config.ts covers src/** only, so the generation lives here to be
// testable — the config is the one artefact where a silent mistake costs a day
// of footage.
describe('renderPaths', () => {
  const camera = {
    slug: 'yard',
    name: 'Yard',
    main: 'rtsp://cam/main',
    sub: 'rtsp://cam/sub',
    deleteAfter: null,
  }

  it('emits a main path and a sub path per camera', () => {
    const yaml = renderPaths([camera])

    expect(yaml).toContain('  yard:')
    expect(yaml).toContain('  yard_sub:')
  })

  // The main path records whether or not anyone is watching; the sub path is
  // dialled only while a browser is connected and is never recorded. Swapping
  // either is the difference between a CCTV system and a webcam.
  it('records the main path and never the sub path', () => {
    const yaml = renderPaths([camera])
    const [main, sub] = yaml.split('  yard_sub:')

    expect(main).toContain('sourceOnDemand: no')
    expect(main).toContain('record: yes')
    expect(sub).toContain('sourceOnDemand: yes')
    expect(sub).toContain('record: no')
  })

  // %path is what puts each camera in its own directory, which is the whole
  // reason timeline/disk.ts can resolve `<slug>/` and get that camera's bytes.
  it('keeps recordPath keyed on %path', () => {
    expect(renderPaths([camera])).toContain('recordPath: ./recordings/%path/%Y-%m-%d_%H-%M-%S-%f')
  })

  it('emits two blocks per camera for seven cameras', () => {
    const cameras = ['yard', 'cam2', 'cam3', 'cam4', 'cam5', 'cam6', 'cam7'].map((slug) => ({
      slug,
      name: slug,
      main: `rtsp://cam/${slug}`,
      sub: `rtsp://localhost:8554/${slug}`,
      deleteAfter: null,
    }))

    const yaml = renderPaths(cameras)

    expect(yaml.match(/sourceOnDemand:/g)).toHaveLength(14)
    expect(yaml).toContain('  cam7_sub:')
  })

  it('indents every path two spaces, so it nests under `paths:`', () => {
    for (const line of renderPaths([camera]).split('\n')) {
      if (line.trim() === '') continue
      expect(line).toMatch(/^ {2,}\S/)
    }
  })

  // A stream URL is pasted from a camera's admin page and can contain anything.
  // Unquoted, a `#` starts a YAML comment and truncates the source — the config
  // renders cleanly and never connects, which is the worst way for this to fail.
  it('quotes the source so a # in a password cannot start a comment', () => {
    const yaml = renderPaths([{ ...camera, main: 'rtsp://admin:pa#ss@10.0.0.5:554/x' }])

    expect(yaml).toContain("source: 'rtsp://admin:pa#ss@10.0.0.5:554/x'")
  })

  it('escapes a single quote in a URL by doubling it', () => {
    const yaml = renderPaths([{ ...camera, main: "rtsp://admin:pa'ss@10.0.0.5:554/x" }])

    expect(yaml).toContain("source: 'rtsp://admin:pa''ss@10.0.0.5:554/x'")
  })

  it('renders `publisher` as a plain value a fake camera can publish to', () => {
    expect(renderPaths([{ ...camera, main: 'publisher' }])).toContain("source: 'publisher'")
  })
})

// Retention is per path, and `recordDeleteAfter` lives in pathDefaults — so a
// short fleet-wide value would reap an existing camera's archive too. The
// per-camera override is what lets seven fake cameras run at 12h on a laptop
// while a real one keeps its week.
describe('cameraConfigs: per-camera retention', () => {
  const base = {
    CAMERAS: 'yard',
    CAMERA_YARD_RTSP_MAIN: 'rtsp://cam/main',
    CAMERA_YARD_RTSP_SUB: 'rtsp://cam/sub',
  }

  it('defaults to null, meaning pathDefaults applies', () => {
    expect(cameraConfigs(base).cameras[0]?.deleteAfter).toBeNull()
  })

  it('reads CAMERA_<SLUG>_RECORD_DELETE_AFTER', () => {
    expect(
      cameraConfigs({ ...base, CAMERA_YARD_RECORD_DELETE_AFTER: '168h' }).cameras[0]?.deleteAfter,
    ).toBe('168h')
  })

  it.each(['7d', '168', 'forever', '1.5h', ''])('rejects the duration %o', (value) => {
    const { errors } = cameraConfigs({ ...base, CAMERA_YARD_RECORD_DELETE_AFTER: value })

    expect(errors.join(' ')).toContain('CAMERA_YARD_RECORD_DELETE_AFTER')
  })

  it('emits recordDeleteAfter on the main path only when overridden', () => {
    const yaml = renderPaths([
      { slug: 'yard', name: 'Yard', main: 'a', sub: 'b', deleteAfter: '168h' },
    ])

    expect(yaml).toContain('    recordDeleteAfter: 168h')
    // The sub path is `record: no`; a retention key there would be noise.
    expect(yaml.split('  yard_sub:')[1]).not.toContain('recordDeleteAfter')
  })

  it('omits recordDeleteAfter entirely when it is not overridden', () => {
    const yaml = renderPaths([
      { slug: 'yard', name: 'Yard', main: 'a', sub: 'b', deleteAfter: null },
    ])

    expect(yaml).not.toContain('recordDeleteAfter')
  })
})

// A stream URL cannot contain whitespace (RFC 3986), so whitespace means a
// typo - a trailing space, or a value that wrapped across lines. Both would
// otherwise reach the rendered YAML, and a newline there injects config.
describe('cameraConfigs: whitespace in a URL', () => {
  it.each(['rtsp://cam/main ', 'rtsp://cam /main', 'rtsp://cam/main\nrogue: yes'])(
    'rejects %o',
    (main) => {
      const { errors } = cameraConfigs({
        CAMERAS: 'yard',
        CAMERA_YARD_RTSP_MAIN: main,
        CAMERA_YARD_RTSP_SUB: 'rtsp://cam/sub',
      })

      expect(errors.join(' ')).toContain('CAMERA_YARD_RTSP_MAIN')
    },
  )
})
