# Architecture

Why Ronda is shaped the way it is. The README says what it does and how to run
it; this says what was decided and what each decision cost.

> **Status.** Live view and playback work end to end: recording, the WHEP proxy,
> the live player, the timeline, and the clip proxy are built. Health and the
> measurement scripts are designed but not yet implemented — the sections below
> say which is which.

---

## The shape

```
camera (ONVIF/RTSP) → MediaMTX (loopback only) → Hono API (Bun) → Next.js web
                            ↓
                      ./recordings/   ← the source of truth for what exists
                                        Postgres holds only auth + events + snapshots
```

Two processes, deliberately. `apps/web` installs with **pnpm**, `apps/api` with
**Bun**. It is not a workspace — two independent installs, wired only by a
type-only import of the API's `AppType`, which gives the web app a fully typed
client with nothing crossing the boundary at runtime.

## Why a separate API server

A single Next.js app would be simpler: one install, one dev command, one deploy.
That is a real option and it is not wrong. It was not chosen for one reason
specific to this domain.

The media server, the recordings, and the disk are physically bound to the
machine that can reach the camera. The UI eventually belongs wherever the
operator is. Those are two machines in any real deployment, and modelling that
split as a process boundary now makes the later move a change of base URL rather
than a rewrite.

Two supporting reasons, in honest order of weight:

1. **Long-lived jobs.** The up/down poller and the nightly coverage snapshot are
   not request-scoped. In a long-lived Bun process that is module-level code. In
   Next it is a lifecycle hook plus a `globalThis` guard to survive dev HMR
   restarting the poller on every edit — workable, but a workaround for a shape
   mismatch.
2. **Footprint.** ~40–80 MB resident against ~200–400 MB. The reference box runs
   other things.

Notably absent from that list: SSR and React Server Components. Every page here
is behind a login and renders live data, so Next's main advantage is simply
unused. That is a reason not to *need* the single-process option — not a reason
to reject it.

## What MediaMTX owns, and what the app owns

**MediaMTX owns the entire media path.** It pulls RTSP from the camera, records
fMP4 segments to disk, serves WebRTC/WHEP for live view, and stitches recorded
windows together by wall-clock time.

The application owns the three things MediaMTX does not:

- **Authentication** — MediaMTX has none worth the name here (see
  [the trust boundary](#the-trust-boundary)).
- **Timeline arithmetic** — merging spans, finding gaps, computing coverage.
- **Honesty about what was actually recorded** — surfacing gaps instead of
  smoothing them over.

If a task sounds like muxing, stitching, or transcoding, MediaMTX already does
it. Reimplementing the stitcher means writing an fMP4 muxer, which is a project,
not a feature.

## The media pipeline

`mediamtx.yml` is **generated**. `mediamtx.template.yml` is tracked;
`cd apps/api && bun run render:mediamtx` substitutes values from `.env` and
writes the real config, which is gitignored — see
[the trust boundary](#the-trust-boundary) for why.

**Two paths per camera, on purpose:**

| Path | Resolution | Recorded | Pulled |
|---|---|---|---|
| `yard` | main, high | continuously | always (`sourceOnDemand: no`) |
| `yard_sub` | sub, low bitrate H.264 | never | only while someone watches |

Live view reads `yard_sub`, so **watching costs almost nothing and a viewer can
never disturb the recording.** That is enforced by the API rather than asked of
the client: `/live/yard/whep` resolves to `yard_sub`, and `/live/yard_sub/whep`
is an unknown camera. There is no request shape that reaches the recorded path.

Segments are **10 minutes**, not the 1-hour default. MediaMTX's reported
timespan durations can disagree with what is on disk, most visibly on the first
segment of a run and on the segment currently being written, so shorter segments
bound that error to ten minutes.

Every protocol the project does not use is turned **off**, not merely left
unbound. At its defaults MediaMTX also serves RTMP, SRT, and MoQ — each a
complete, unauthenticated way to read the camera.

### Development without a camera

Docker Compose runs MediaMTX, Postgres, and `fakecam` — ffmpeg looping an H.264
fixture into the `yard` path. The fixture is already H.264 so `-c copy` works:
no transcode, negligible CPU, and the stream behaves like a real camera.

`yard_sub` has no publisher in development, and it cannot get one from a
Compose environment variable: MediaMTX splits path names on `_`, so
`MTX_PATHS_YARD_SUB_SOURCE` is parsed as path `yard`, key `sub_source`, and
discarded **silently**. (Verified against v1.20.1: an equivalent `yardsub` path
takes the override and `yard_sub` does not, and neither `__` nor lowercase
escapes it.) So the sub-stream's source is a render-time token instead.
`.env.example` points it at the server's own `yard` path, which MediaMTX relays
on demand — no second ffmpeg, no transcode, and the on-demand property is
preserved. Leave `YARD_SUB_SOURCE` unset and it renders the real camera URL.

`docker compose stop fakecam` produces a genuine recording gap, which is how the
timeline gets tested without unplugging anything.

## The trust boundary

Even on a LAN, and especially because v1 is the foundation for something later
exposed:

- **MediaMTX is unauthenticated and bound to loopback.** Its own ACL cannot
  express "only this machine" from behind container NAT, so the boundary that
  actually holds is the publish address: Compose publishes every port to
  `127.0.0.1` only. That prefix is load-bearing — dropping it exposes the
  control API and the camera stream to the LAN.
- **The authenticated API is therefore the only way in.** Every media route
  resolves the session server-side. An unauthenticated request cannot reach a
  stream by guessing a port.
- **Sessions are httpOnly cookies** (Better Auth), CORS restricted to the web
  origin with `credentials: true`. Sign-up is disabled; the single operator
  account is created by `db:seed`.
- **The RTSP path is the password's MD5.** On this camera family the URL is
  `rtsp://<ip>:5543/<md5(ONVIF_PASSWORD)>/live/channel0`, so a leaked stream URL
  leaks a password hash. That is why the rendered `mediamtx.yml` is gitignored
  while the template is tracked, and why `doctor` masks the hash when printing.
- **The web app never holds a database credential.** It talks to the API; the
  API talks to Postgres.
- **WHEP session ids are mapped to the session that created them**, and `PATCH`
  and `DELETE` verify ownership. A session the caller does not own reads as
  absent rather than forbidden, so the status code does not enumerate live ids.

### The WHEP proxy

WHEP is three requests: `POST` an SDP offer and get an answer, `PATCH` to
trickle ICE candidates, `DELETE` to hang up. The answer to the `POST` carries a
`Location` header, and the browser sends its `PATCH` and `DELETE` there.

MediaMTX returns a `Location` pointing at **itself**. Forward it unchanged and
the browser bypasses the API and its session check entirely — and since MediaMTX
is loopback-bound, those requests simply fail and the stream dies after roughly
ten seconds with nothing in any log you would think to open. The proxy rewrites
it to `/live/:slug/whep/:session`.

Two smaller versions of the same failure sit beside it. `Location` and `ETag`
are not CORS-safelisted, so the API must name them in
`Access-Control-Expose-Headers` or the browser reads `null` for the very header
the proxy exists to rewrite. And teardown is idempotent: closing a tab drops ICE
and MediaMTX reaps the session before the `DELETE` arrives, so forwarding its
`404` would make the ordinary path look like a failure.

The offer is sent complete rather than trickled. With host candidates only —
there is no NAT to traverse — ICE gathering beats the signalling round-trip, so
waiting for it costs nothing and removes both the SDP-fragment builder and the
`ETag` exchange from the browser. `PATCH` is implemented and tested regardless;
it is part of WHEP.

Media itself does **not** flow through the proxy: the browser talks to MediaMTX
directly over ICE. Only signalling is brokered.

## The API surface

Every route is session-guarded and validates its input. The web app holds no
database credential — it talks to the API, the API talks to Postgres.

| Method | Path | |
|---|---|---|
| `ALL` | `/api/auth/*` | Better Auth |
| `GET` | `/cameras` | cameras plus current live status |
| `POST` | `/live/:slug/whep` | SDP offer to answer; `Location` rewritten |
| `PATCH` | `/live/:slug/whep/:session` | trickle ICE |
| `DELETE` | `/live/:slug/whep/:session` | tear the session down |
| `GET` | `/recordings/:slug/timeline` | spans, gaps, coverage for a window |
| `GET` | `/recordings/:slug/clip` | proxied playback window, `Range`-aware |
| `GET` | `/health` | disk free, days remaining, 24h coverage |
| `GET` | `/health/events` | SSE — status transitions as they happen |

*`/health` is designed but not yet built.*

The web app builds a fully typed client from a **type-only** import of the API's
`AppType`. Nothing crosses that boundary at runtime, but it does mean the web
app's typecheck reads the API's source — so anything reachable from `AppType`
must stay runtime-agnostic (`process.env` and global `fetch`, never `Bun.*`), or
the web build fails while pointing at an API file.

## Data

Postgres via Drizzle, over TCP with `postgres.js` — the API is a long-lived
process, not a serverless function, so a warm pool beats a round-trip per query.

Two connection strings, one job each: `DATABASE_URL` is **pooled** for runtime,
`DATABASE_URL_DIRECT` is **unpooled** for migrations, because a transaction-mode
pooler does not support the session-level statements `drizzle-kit` issues. They
must point at the same database — a hosted pooled URL with a local direct URL
migrates one database while the app reads another, and neither side says a word.

**There is deliberately no segments table.** The filesystem plus MediaMTX's
`/list` is the source of truth. A second index drifts the first time a file is
deleted out of band, and a timeline that disagrees with the disk is worse than
no timeline. The only recording-related tables are `stream_events` (up/down
*transitions* only — polling every 10s and writing every poll would be 8,640
rows a day of nothing) and `daily_coverage`, which outlives the recordings the
retention window deletes.

## Timeline, gaps, and coverage

The naive model — recordings are a continuous line, playback is an offset into
it — is wrong in four ways, and each one is the interesting part.

1. **Recording is a sequence of spans, not a line.** A new timespan starts
   whenever recording was interrupted: camera reboot, network blip, service
   restart. The space between two timespans is the single most operationally
   important fact in the system, and the naive model has nowhere to put it.
2. **Adjacent segments are not exactly adjacent.** Consecutive segments within
   one run are separated by a few hundred milliseconds of muxer boundary.
   Treating every sub-second discontinuity as a gap confetti-s the timeline with
   hundreds of meaningless holes, so merging uses a stated **2-second
   tolerance**: under it is an artefact, over it is real and shown.
3. **Timezone.** Recording filenames are written in the server's local time
   while the playback API speaks RFC3339 with an offset. Parsing one as the
   other shifts the whole timeline by hours, and the bug is invisible to any
   test whose fixtures were generated in the timezone they are read in. The
   rule: **epoch milliseconds UTC everywhere internally**, formatted to
   camera-local only at the render boundary. CI runs the suite under two
   timezones for exactly this reason.
4. **Reported durations are not always trustworthy.** Mitigated structurally
   with 10-minute segments, and by ending the window itself at `now` rather than
   at the requested end — so the hours of today that have not happened yet are
   not counted against coverage, and half a recorded hour cannot read as a fully
   covered one. Where the reported durations still overrun the present, the
   response says so in an optional `clamped` field instead of silently absorbing
   it, and `measure` cross-checks durations against file sizes.

**Gaps are first-class output.** The timeline response carries spans, gaps with
an inferred cause, and a coverage fraction. Rendering a gap as continuous
recording is the specific failure this project exists to avoid. A playback
request landing inside a gap returns `409` with the nearest available span,
never an empty video element.

Three things follow from that in the rendering, and they are the reason the
timeline bar is not just a list of coloured divs:

- The bar's **background is the gap colour** and recorded spans are painted on
  top. A hole too narrow to occupy a pixel then still shows as a hairline rather
  than disappearing, which is the one way this bar may not fail.
- **Hours that have not elapsed are a third state**, neither recorded nor gap.
  Drawing the rest of today as a gap would report a multi-hour outage that never
  happened — the same dishonesty as hiding a real one, pointed the other way.
- **Coverage never prints as 100%** while a gap is listed. A two-second hole in
  a day is 99.9977%, which rounds up at two decimals, and a perfect score beside
  visible holes is precisely the contradiction the page exists to avoid.

The gap list under the bar carries the same facts as the bar itself. Tooltips do
not open on touch and a two-pixel sliver is not a screen-reader target, so the
list — not the bar — is the representation that survives without a pointer.

## Playback

Clicking a timeline position at wall-clock `t` requests a window, and the API
proxies MediaMTX's playback endpoint. **MediaMTX does the stitching** — it
concatenates across segment boundaries and cuts on wall-clock time, so the app
never opens a video file.

The proxy has one requirement that is easy to get wrong: `Range`,
`Content-Range`, `Accept-Ranges`, and `206` all have to survive the hop, and the
body must be **piped rather than buffered**. Reading the window into memory
before responding works fine for five minutes of video in development and falls
over the first time someone asks for an hour.

Today that passthrough is fidelity rather than an active code path. MediaMTX's
`/get` answers `Accept-Ranges: none` and ignores a `Range` header entirely, so
it never returns a `206`. The proxy forwards the header up and mirrors whatever
comes back regardless, and the tests drive a mocked `206` to prove it — a proxy
that only forwards what today's upstream happens to send is one upstream release
away from breaking seeking with nothing in any log.

Response headers are **allowlisted, never copied wholesale**. MediaMTX answers
`/get` with `Access-Control-Allow-Origin: *`, and a wildcard on a credentialed
response is one the browser rejects outright; the CORS middleware is the only
thing entitled to set that header.

### fMP4 or MP4

MediaMTX offers both, and the choice decides whether the native controls work.

`fmp4` is the default and writes `mvhd.duration = 0` — a fragmented stream does
not know its length up front. A `<video>` fed that reports a duration of
`Infinity`, and its scrubber never becomes usable. Playback looks fine until
somebody tries to seek.

`mp4` builds the sample tables first, so the moov carries the real duration
(measured: `10033` ms for a ten-second window) and seeking works with no custom
scrubber and no player library. It costs nothing worth having: a 300-second
window starts arriving in 0.59s, a 3600-second one in 1.18s. MediaMTX does hold
those sample tables in memory while it muxes, which is part of what the
3600-second bound on `duration` is protecting.

So the proxy asks for `format=mp4`, and **the timeline's own player is a plain
`<video controls>`** — no scrubber of our own, because there is nothing left for
one to do.

A request whose start lands in a gap returns `409` with the nearest available
span, rather than an empty video element with no explanation. `nearest` measures
to the closer *edge* of a span, not to its start: an instant twenty seconds past
the end of an hour of footage is twenty seconds from footage. The web app
reaches the same verdict from the spans the timeline already loaded, so the
message appears with no round trip; the `409` remains the authority and is what
any other client gets.

Two smaller things the route inherits from MediaMTX. Its `/get` separates cases
that `/list` does not — `404 no recording segments found` for an instant with no
footage, `400` for a path it has never heard of — so a `404` here (retention
deleting a segment mid-request) is answered as the gap it is, while a `400` is a
`502`. And the `<video>` element must carry `crossOrigin="use-credentials"`: the
API is a separate origin, and without it the element sends no session cookie,
the route answers `401`, and the player shows an empty box with no error
anywhere.

Window length is bounded at an hour, and the route is rate limited to 30
requests a minute per user — one clip can make MediaMTX mux an hour of video, so
the bound is on work done upstream, not on bytes moved here.

## Measurement

*Designed; not yet built.*

The thing that separates this from a tutorial: the system reports how well it
actually worked, and the number goes in the README.

- **`doctor`** runs once at setup. It probes both RTSP URLs and prints codec,
  resolution, framerate, and measured bitrate, then makes three calls: warn if
  the main stream is H.265, because those recordings will not play in most
  browsers; warn if the sub-stream is missing or not H.264, because live view
  would need transcoding this project does not do; and project GB/day and
  days-until-full against actual free disk. A retention setting nobody checked
  against a real bitrate is a guess.
- **`measure`** reports coverage, storage, and time-to-first-frame over the last
  24 hours — including the discrepancy between reported timespan durations and
  on-disk file sizes, rather than hiding it.

Both need a real camera and real elapsed time, so they stay manual and out of
CI. They exist to answer one question honestly — *did this thing actually record
last night?* — and to replace an adjective in the README with a number.

## Observability

No Prometheus, no Grafana; one camera does not need a metrics stack.

- **`stream_events`** is the audit trail. Every up/down transition with a
  timestamp is what turns an anonymous hole in the timeline into "the camera
  rebooted at 03:14". A poller in the Hono process reads MediaMTX's control API
  every 10 seconds and writes a row only when the answer changes.
- **`daily_coverage`** is the long memory. Recordings are deleted after the
  retention window; the record of how reliable the system was should outlive
  them.
- **`/health/events`** pushes transitions to the health page over SSE, so a
  watching operator sees a drop when it happens rather than at the next refresh.

Three decisions in the poller are load-bearing and none of them are obvious from
the code alone:

- **The last known state lives in memory, not in a query.** Re-reading the last
  event every tick would be correct and would also keep Neon's compute awake
  around the clock, against the same budget `idle_timeout: 30` exists to
  protect. Postgres is touched twice at startup and once per transition, so a
  camera that stays up costs nothing after boot. The price is that the camera
  list is read once — adding a camera needs a restart.
- **An unreachable control API is not a `down`.** It is the same distinction
  `/cameras` draws between "this camera is down" and "we could not tell":
  writing `down` there would blame the camera for the API server's own
  blindness and label the gap `camera_down` on no evidence. The poller logs and
  retries, and the gap reads `unknown` — which is the honest answer.
- **The timestamp is the moment of detection, never `readyTime`.** `inferCause`
  matches a `down` only inside `[gap.start, gap.end)`, and a transition
  detected up to ten seconds late lands just inside the gap it explains.
  Backdating it to the path's `readyTime` would place it before the gap began,
  the match would fail, and the gap would read `unknown` with nothing wrong in
  any log. Measured on a three-minute outage: the gap opened at 04:18:24.829
  and the `down` was recorded at 04:18:25.622, 0.79s inside it. The ordering is
  structural rather than lucky — the poller cannot observe a disconnect before
  it happens.

Two things are worth watching: **coverage trending down**, which means something
is failing intermittently and nobody has noticed, and **bytes/hour trending up**,
which means the bitrate drifted and retention will be shorter than configured.
Both are visible without opening a log.

## Testing

- **Vitest** for the arithmetic and the guards: span merging at, just under, and
  just over the tolerance; gap detection for windows that start inside a span,
  end inside one, contain none, and are fully covered; the WHEP `Location`
  rewrite against a MediaMTX-shaped response; ownership guards on every route.
- **Playwright** for the walk: sign in, see a decoded frame, open recordings,
  click a covered position, watch it play. Then stop the fake camera, restart
  it, and assert the gap appears in the timeline with the right duration — that
  last test is the whole project in one assertion.
- **Docker Compose** so `docker compose up` gives a working camera on any
  machine, with no physical hardware.
- **GitHub Actions** runs typecheck, lint, and the unit suite under both `UTC`
  and `Asia/Jakarta`. The `doctor` and `measure` scripts stay manual — they need
  a real camera and real elapsed time.

## What this deliberately does not do

Each of these was considered and cut. The reason matters more than the cut.

- **No remote access to the media path.** No tunnel, no VPN, no VPS. Traversing
  CGNAT to reach a home LAN is a genuinely separate problem with its own failure
  modes, and mixing it in means never being sure whether a bug is in the app or
  the tunnel. The hosted database is the one deliberate exception, and it costs
  something real: authentication needs the internet, so an ISP outage stops
  anyone signing in to watch a camera five metres away. Recording is unaffected —
  the camera and MediaMTX never touch the database.
- **No HLS fallback.** A second player path doubles the surface to test in
  exchange for a latency profile nobody wants on a live camera. WebRTC holds
  sub-second; HLS floors at roughly 8 seconds because it is a playlist of
  segments and the player needs several buffered before it starts. No tuning
  closes that gap — the segmenting *is* the protocol.
- **No custom segment stitching.** MediaMTX already concatenates across segment
  boundaries and cuts on wall-clock time.
- **No segments table.** See [Data](#data).
- **No motion or object detection.** It would mean a second pipeline — frame
  extraction, inference, an event store — that would dominate the project.
  Continuous recording first.
- **No transcoding.** An H.265 main stream is surfaced as a warning and handled
  by recording the H.264 sub-stream for playback, not by building an ffmpeg farm
  on a box that has other jobs.
- **No RBAC, no multi-tenant.** One operator account. Camera-level permissions
  are a different project.
- **No PTZ, no two-way audio.** The reference camera is fixed, and v1 records
  video only.
