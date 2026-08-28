// A read-only mirror of mediamtx.template.yml, for the Settings screen.
//
// This is a SECOND reader of that file and it drifts if the template changes —
// there is no endpoint that reports MediaMTX's configuration, and adding one to
// serve a display-only screen would put a second parser of the media config in
// a second process for no operational gain. Anything here that stops matching
// the template is a bug in this file, not in the recorder.
//
// Nothing derived from a secret appears here. The RTSP path embeds
// md5(ONVIF_PASSWORD) (docs/ARCHITECTURE.md#the-trust-boundary), so the SHAPE
// is written out as literal text and the hash is never interpolated — the web
// app has never held it and must not start.

export const RETENTION_HOURS = 168
export const SEGMENT_DURATION = '10 minutes'
export const RECORD_FORMAT = 'fMP4, 1s parts'
export const RTSP_PORT = 5543

export const RTSP_SHAPE = 'rtsp://<camera-ip>:5543/<md5(ONVIF_PASSWORD)>/live/channelN'

export const STREAMS = [
  {
    channel: 'channel0',
    title: 'Main stream',
    role: 'recorded continuously',
    detail: 'sourceOnDemand: no — it must record whether or not anyone is watching',
    badge: 'record: yes',
  },
  {
    channel: 'channel1',
    title: 'Sub stream',
    role: 'live view only',
    detail: 'sourceOnDemand: yes — pulled only while a browser is connected, and never recorded',
    badge: 'on demand',
  },
] as const

// The last run committed to README.md, reproduced verbatim. It is a record, not
// a reading: both scripts need a real camera and real elapsed time, so neither
// runs in CI and neither can be triggered from here
// (docs/ARCHITECTURE.md#measurement).
export const LAST_MEASURE_RUN = '28 Aug 2026'
export const LAST_MEASURE_OUTPUT = `measure: coverage (yard)
  coverage          65.35%
  gaps              5 over 2s

  from                 duration   cause
  27/08/2026, 18:19:08 37m 21s    unknown
  28/08/2026, 02:08:17 7h 7m      unknown
  28/08/2026, 11:18:24 3m 11s     camera_down
  28/08/2026, 11:59:07 30m 3s     unknown
  28/08/2026, 13:56:05 1m 7s      camera_down

measure: storage (yard)
  written           2.95 GB in 24h (123 MB/hour)
  projected         2.95 GB/day, 55.14 GB free = 18.7 days
  reported          15h 41m from MediaMTX /list
  on disk           15h 45m implied by size at 52.0 kB/s
  discrepancy       -4m 14s (-0.45%)

measure: time to first frame (median of 5, yard)
  whep post         25 ms
  first frame       795 ms`
