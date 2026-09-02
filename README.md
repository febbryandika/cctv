# Ronda

Local CCTV for a small camera fleet — seven in the reference install: sub-second
live view in the browser, weeks of continuous recording, and a timeline that
shows you the holes instead of hiding them.

![Live view, then scrubbing the timeline into a recorded gap and back](docs/screenshots/ronda.gif)

---

## The problem

A browser cannot play RTSP — that is a protocol mismatch rather than a missing
library, so something has to translate, and which translation you pick sets the
latency floor at either half a second or eight.

The second problem is the one that bites later: recording is not one continuous
file but a sequence of segments with holes between them, and a timeline drawn as
one unbroken bar is a claim about footage that may not exist. The moment you
need it is the moment you find out. A recorder that hides its gaps is worse than
no recorder, because it costs you the chance to fix the camera.

## Architecture

```
 7 cameras              MediaMTX                  Hono API              Next.js
(ONVIF/RTSP)         (loopback only)               (Bun)                 (web)
     │                     │                         │                     │
     ├──── RTSP pull ─────►│                         │                     │
     │                     │◄──── control API ───────┤                     │
     │                     │◄──── playback API ──────┤                     │
     │                     │◄──── WHEP signalling ───┤◄──── HTTP + ────────┤
     │                     │                         │      session cookie │
     │                     │═══════ WebRTC media, browser ↔ MediaMTX ══════►│
     │                     ▼                         ▼
     │           ./recordings/<slug>/          Neon Postgres
     │           fMP4, 10-min segments        auth · stream_events
     │        the source of truth for          · daily_coverage
     │            what was recorded         (never video, never paths)
```

Only signalling crosses the API; the media itself flows browser ↔ MediaMTX over
ICE. MediaMTX binds to `127.0.0.1` on every port, so the authenticated API is
the only way in ([the trust boundary](docs/ARCHITECTURE.md#the-trust-boundary)).

### Why a separate API server?

Because the two halves belong in different places, and it is cheaper to admit
that now than to discover it later. The media server, the recordings and the
disk are physically bound to the machine that can reach the cameras; the UI
eventually belongs wherever the operator is. Modelling that split as a process
boundary today makes the later move a base-URL change instead of a rewrite.

Two supporting reasons, in honest order of weight. The up/down poller and the
nightly coverage snapshot are long-lived jobs — plain module-level code in a
Bun process, versus a lifecycle hook plus a `globalThis` guard to survive HMR in
a single Next app. And footprint: ~40–80 MB resident against ~200–400 MB, on a
box that has other work to do.

Notably absent from that list: SSR and React Server Components. Every page here
is behind a login and renders live data, so Next's main advantage is simply
unused — which is a reason not to *need* the single-process version, not a
reason to reject it. Next.js full-stack would have been a perfectly good
call; [the full argument is in
ARCHITECTURE.md](docs/ARCHITECTURE.md#why-a-separate-api-server).

## How live view works

The browser cannot play RTSP — that is a protocol mismatch, not a library gap —
so something has to translate. MediaMTX serves each camera over WebRTC, and the
API brokers the handshake. WHEP, end to end:

1. The browser creates an `RTCPeerConnection`, adds a `recvonly` video
   transceiver, and generates an SDP offer.
2. It `POST`s the offer to `/live/:slug/whep` as `application/sdp`.
3. The API resolves `:slug` to that camera's **sub-stream**, forwards the offer
   to MediaMTX, and returns the answer — with the `Location` header **rewritten
   to point back at the API**.
4. The browser attaches the remote track. From here media flows browser ↔
   MediaMTX directly over ICE; only signalling ever goes through the API.
5. On unmount or `pagehide`, a `DELETE` to that rewritten URL tears the session
   down.

Every camera mounts its own player, so the live page runs seven of these at
once. Clicking a tile fills the view and the rest are **hidden, not unmounted**
— focusing is a layout change, so no session is torn down and going back to the
grid is instant rather than seven fresh handshakes.

### The `Location` header is the whole trick

MediaMTX answers step 3 with a `Location` pointing at **itself**. Forward it
unchanged and the browser sends its `PATCH` and `DELETE` straight to MediaMTX,
bypassing the session check entirely — and because MediaMTX binds to `127.0.0.1`
([why](docs/ARCHITECTURE.md#the-trust-boundary)), those requests simply fail. The
stream dies after roughly ten seconds with nothing in any log you would think to
open. Rewriting it to `/live/:slug/whep/:session` is a three-line change and the
difference between a working player and an unexplainable one.

Two smaller versions of the same failure sit next to it. `Location` and `ETag`
are not CORS-safelisted, so the API has to name them in `Access-Control-Expose-Headers`
or the browser reads `null` for the very header the proxy exists to rewrite. And
WHEP session ids are mapped to the authenticated session that created them, so
`PATCH` and `DELETE` verify ownership rather than trusting an opaque id from the
wire.

The test for all of this is a clock: **if live view is still playing after thirty
seconds, the rewrite is correct.** Ten seconds is what a bypassed session buys
you.

### Why WebRTC and not HLS

Latency, and it is not close. WebRTC holds sub-second glass-to-glass; HLS floors
at roughly 8 seconds because it is a playlist of segments and the player needs
several of them buffered before it starts. For recorded playback that is
irrelevant. For a camera it is the entire point — 8 seconds late is a different
product, and no amount of tuning closes that gap because the segmenting *is* the
protocol.

So there is no HLS fallback — and [what else was
cut](docs/ARCHITECTURE.md#what-this-deliberately-does-not-do). A second player
path would double the surface to test in exchange for a latency profile nobody
wants on a live camera, and WebRTC covers every browser this targets.

### Why live view reads the sub-stream

Each camera is two MediaMTX paths, named after its slug: `yard` — high
resolution, recorded continuously, `sourceOnDemand: no` — and `yard_sub` — low
bitrate, H.264, pulled only while someone is watching, never recorded. Seven
cameras is fourteen paths, all generated from one list in `.env`.

Live view reads `yard_sub`, so watching costs almost nothing and **a viewer can
never disturb the recording** ([the two
paths](docs/ARCHITECTURE.md#the-media-pipeline)). That is enforced by the API
rather than asked of the client: `/live/yard/whep` resolves to `yard_sub`, and
`/live/yard_sub/whep` is an unknown camera. There is no request shape that
reaches the recorded path.

## How playback works

**Segments.** MediaMTX writes fMP4 to `recordings/<slug>/` — one directory per
camera — in ten-minute segments, and deletes them after `RECORD_DELETE_AFTER`,
about three weeks in the reference install. Ten minutes rather than the one-hour
default for a specific reason: the durations the playback API reports can
disagree with what is on disk, most visibly on the segment currently being
written, so a shorter segment bounds that error to ten minutes instead of an
hour.

**Timespans.** Asking MediaMTX's playback API for `/list?path=yard` returns
*timespans* — contiguous runs, already concatenated across the segment
boundaries inside them. A new timespan begins wherever recording was
interrupted, so **two timespans mean a hole between them**. That list is the
only input the timeline has, and there is deliberately no database table
shadowing it: the filesystem is the source of truth, and a second index would
drift the first time a file was deleted out of band.

**MediaMTX does the stitching, not us.** Asking it for a window by wall-clock
time returns one continuous stream cut to those boundaries, spanning as many
segments as it needs to. The reason to use that rather than write it is
straightforward: the alternative is implementing an fMP4 muxer, and the payoff
is a worse version of something that already works. The app never opens a video
file. It does timeline arithmetic on the *list*, and proxies the bytes.

The proxy has three narrow jobs, each of which is a bug if skipped. It **pipes**
the body rather than buffering it — fine for a 300-second window in development,
fatal the first time somebody asks for an hour. It **allowlists** response
headers, because MediaMTX answers `/get` with `Access-Control-Allow-Origin: *`
and a browser rejects a wildcard on a credentialed request. And it forwards
`Range` and `206` even though today's MediaMTX ignores them on this endpoint —
fidelity now is cheaper than a subtle regression later.

One parameter is load-bearing: the clip is requested as `format=mp4`, not the
`fmp4` default. fMP4 writes `mvhd.duration = 0`, so `<video>.duration` reads
`Infinity` and the native scrubber never works — playback that looks perfect
until somebody tries to seek.

And a click that lands in a hole returns **409 with the nearest available
span**, measured to the nearer edge, rather than an empty player with no
explanation. That is the same honesty rule as the timeline, one layer down.

## Coverage

A recorder that hides its gaps is worse than no recorder, so the system measures
itself and the number goes here — whatever it says. `cd apps/api && bun run
measure`, which reports every camera in turn. One of them, against a fake camera
on a development laptop:

```
measure: coverage (yard)
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
  first frame       795 ms
```

**65.35% is a bad number and it is the real one.** The seven-hour hole at 02:08
is a laptop that went to sleep; the 37-minute and 30-minute holes are the same
machine doing other things. This is not what the recorder does on a box that
stays awake — but publishing 99.9% from a cherry-picked window would defeat the
only purpose the number has.

The two gaps labelled `camera_down` are the interesting ones. `stream_events`
records up/down *transitions* — the poller writes a row when the state changes,
not on every 10-second tick — so a gap that overlaps a `down` event can be
explained. The last one is reproducible in ninety seconds:
`docker compose stop fakecam`, wait, `docker compose start fakecam`, re-run
`measure`, and the outage appears with its real duration and its cause. The three
`unknown` gaps are honest too: the API was down for those, so nothing was
watching, and the system says so rather than guessing.

### The method, and the 2-second tolerance

MediaMTX's playback `/list` returns contiguous timespans. Those get merged, the
complement within the window is the gaps, and coverage is
`1 - gapTime / windowTime`. All of it in epoch milliseconds UTC
([why](docs/ARCHITECTURE.md#timeline-gaps-and-coverage)); wall-clock strings are
produced once, at the render boundary.

Merging needs a tolerance, and the value is load-bearing. Consecutive segments
inside a single uninterrupted run are separated by a few hundred milliseconds of
muxer boundary. With no tolerance the timeline is confetti-ed with hundreds of
meaningless holes; with too generous a tolerance real outages vanish into the
smoothing. **`TOLERANCE_MS = 2000`** — under two seconds is a muxer artefact,
over two seconds is a hole in the record. It is unit-tested at, just under, and
just over the boundary, and the whole module is pure functions over numbers, so
those tests are cheap.

Two consequences worth knowing. Coverage is computed exactly while the printed
gap table drops sub-tolerance holes, so coverage can sit a hair under 1 with an
empty table — the two are never derived from each other. And spans are half-open
`[start, end)`, so the instant at a span's end belongs to the gap after it.

### Reported vs. on disk

MediaMTX's reported timespan durations can disagree with what is actually on
disk, most visibly on the segment currently being written. Rather than trust
them, `measure` builds a second estimate the reported durations had no part in:
a complete segment is `recordSegmentDuration` long, so the *median* segment size
divided by ten minutes is a bytes-per-second derived purely from the filesystem.
Running the total bytes back through it gives the `on disk` figure above. The two
agreed to within half a percent here; the run prints the discrepancy either way
instead of picking a winner.

That is also why segments are ten minutes rather than the one-hour default — a
wrong duration misplaces at most ten minutes.

`doctor` is the setup-time counterpart: it probes both RTSP URLs (printing them
with the password hash masked), measures the real bitrate with a ten-second
sample, and refuses to pass if the main stream is H.265, if the sub-stream is not
H.264, or if the measured bitrate fills the disk before `recordDeleteAfter`
expires. Both scripts exit non-zero on a failed check, so either can gate a
deployment. Both need a real camera and real elapsed time, so neither runs in CI.

## What I deliberately didn't build

Each of these was considered and cut. The reason matters more than the cut.

**No remote access to the media path.** No Tailscale, no WireGuard, no reverse
proxy, no VPS. Traversing CGNAT to reach a home LAN is a genuinely separate
problem with its own failure modes, and mixing it in here means never being sure
whether a bug is in the app or in the tunnel. v1 runs on the LAN and is correct
there first.

The database is the one deliberate exception, and it costs something real: the
API needs the internet to authenticate, so **an ISP outage stops anyone signing
in to watch a camera five metres away.** Recording is unaffected — the camera
and MediaMTX never touch the database — but nobody can watch. That is an
acceptable trade for a v1 whose job is to be understood and extended, and it
would not be acceptable for a system somebody relied on. The fix at that point
is Postgres on the same machine: same schema, same migrations, different host.

**No custom segment stitching.** MediaMTX already concatenates across segment
boundaries and cuts on wall-clock time. Reimplementing it means writing an fMP4
muxer — strictly more code to end up with strictly less reliable playback.

**No segments table.** The filesystem plus MediaMTX's `/list` is the source of
truth. A second index drifts the first time a file is deleted out of band, and a
timeline that disagrees with the disk is worse than no timeline — it is the
failure this project exists to avoid, reintroduced one layer down.

**No motion or object detection.** MediaMTX does not do it, so adding it means a
second pipeline — frame extraction, inference, an event store — that would
dominate the project and compete for the CPU that currently just copies bytes.
Continuous recording first; events are a different product.

**No transcoding.** If the camera emits H.265 the recordings are smaller and
unplayable in most browsers. That is surfaced as a warning by `doctor` and
handled by recording the H.264 sub-stream for playback, rather than by running
an ffmpeg farm on a machine that also has other jobs.

**No RBAC, no multi-tenant.** One operator account, created by `seed`, with
sign-up disabled. Camera-level permissions are a different project and would
change the shape of every route.

**No HLS fallback.** A second player path doubles the surface to test in
exchange for a latency profile nobody wants on a live camera. HLS floors at
roughly eight seconds because it is a playlist of segments and the player needs
several buffered before it starts — the segmenting *is* the protocol, so no
amount of tuning closes that gap. WebRTC covers every browser this targets.

**No PTZ, no two-way audio.** The reference camera is fixed, and v1 records
video only.

**No deployment config.** v1 is `bun dev` on the LAN; Neon is the only hosted
piece. Writing Dockerfiles and a compose stack for a topology that has not been
decided yet would be guessing, and the guess would rot.

## Local setup

```bash
git clone <repo> && cd cctv
cp .env.example .env                 # camera list, stream URLs, DATABASE_URL
mkdir -p recordings                  # bind-mount target, owned by you not root
(cd apps/api && bun run render:mediamtx)   # .env → mediamtx.yml (generated)
docker compose up -d                 # MediaMTX + fake camera + postgres
cd apps/api  && bun install && bun run db:migrate && bun run db:seed && bun dev
cd apps/web  && pnpm install && pnpm dev
```

`mediamtx.yml` is **generated** from the tracked `mediamtx.template.yml` and is
not itself tracked: a stream URL carries the camera's credentials, either as a
password in userinfo or as `md5(password)` in the path, so committing the config
would commit them ([why](docs/ARCHITECTURE.md#the-trust-boundary)). If the file
is missing, `docker compose up` fails rather than starting MediaMTX on its
defaults — which would quietly mean HLS on, RTMP on, and nothing recorded.

**The camera list lives in `.env` and nowhere else.** `CAMERAS` is an ordered
list of slugs, and each one gets three variables:

```bash
CAMERAS=yard,cam2,cam3,cam4,cam5,cam6,cam7
CAMERA_YARD_NAME=Yard
CAMERA_YARD_RTSP_MAIN=rtsp://admin:pw@192.168.1.50:554/V_ENC_000   # recorded
CAMERA_YARD_RTSP_SUB=rtsp://localhost:8554/yard                     # live view
```

A slug is a MediaMTX path name, a directory under `recordings/`, and half of
those variable names, so it is lowercase letters and digits only — no dash
(illegal in an environment variable name) and no underscore (MediaMTX splits
`MTX_PATHS_*` on `_`, and `<slug>_sub` is already the live-view path). Choose
them once: renaming one later means moving its recordings directory and
rewriting `stream_events` and `daily_coverage` by hand, because both foreign
keys are `ON DELETE CASCADE`, not `ON UPDATE`. The label in
`CAMERA_<SLUG>_NAME` is the part that *is* cheap to change.

`CAMERA_<SLUG>_RTSP_MAIN=publisher` declares a camera with no hardware yet: the
matching `fakecam` service publishes the test fixture into it. That is how a
fresh clone gets seven working cameras with no camera.

After any change, re-render **and restart** — MediaMTX reads the file at
startup, so a render on its own changes nothing:

```bash
(cd apps/api && bun run render:mediamtx) && docker compose restart mediamtx
```

`RECORD_DELETE_AFTER` sets retention, and `CAMERA_<SLUG>_RECORD_DELETE_AFTER`
overrides it for one camera. The override exists because retention is a
`pathDefaults` value: without it, dropping the fleet to `12h` to keep seven fake
cameras off a laptop disk would also reap the archive of a real camera, within
minutes of the restart. It is also how a till camera keeps three weeks while a
stockroom keeps one.

Retention is by **age only** — there is no global size cap and nothing evicts
under disk pressure, so `RECORD_DELETE_AFTER` × the number of cameras has to fit
the disk. Set it from a measured `bytesPerHour` off `/health`, not from a
datasheet: if the real bitrate runs high the disk fills and *every* camera stops
recording at once, and `daysRemaining` will have been counting down to it with
nothing acting on the warning.

If a camera is real, turn its fake off so it is not retrying into a refusal for
the life of the stack — a path that pulls cannot also accept a publisher:

```bash
docker compose up -d --scale fakecam=0     # yard is real hardware
```

Ports are published to `127.0.0.1` only ([the trust
boundary](docs/ARCHITECTURE.md#the-trust-boundary)). Postgres is on **5439**, not
5432, because a natively-installed Postgres usually owns the standard port —
`.env.example` already points at 5439.

`DATABASE_URL` and `DATABASE_URL_DIRECT` must point at the **same** database:
the pooled and unpooled hosts of one Neon branch, or both at the Compose
Postgres. Mixing them — a Neon pooled URL for the app and a localhost direct
URL for migrations — migrates one database while the app reads another, and
neither side says a word.

Sign in at <http://localhost:3000> with the account `bun run db:seed` creates
and prints:

```
operator@ronda.local / ronda-operator
```

Override them with `SEED_OPERATOR_EMAIL` and `SEED_OPERATOR_PASSWORD` for
anything that is not a local dummy install. **Sign-up is disabled** — there is
one operator account and `seed` is the only thing that can create it, so
`POST /api/auth/sign-up/email` answers `400 EMAIL_PASSWORD_SIGN_UP_DISABLED`.
`seed` is idempotent; re-running it changes nothing.

Four checks say the media layer is actually working, not merely running. They
use `yard` as the example; every camera in `CAMERAS` has the same two paths and
answers the same way:

```bash
# 1 — the stream plays
ffplay -rtsp_transport tcp -fflags nobuffer rtsp://127.0.0.1:8554/yard
#   a 1920x1080 test pattern with a running two-decimal counter
#   (ffprobe rtsp://127.0.0.1:8554/yard, or VLC, do just as well)

# 2 — segments are landing on disk, one per 10 minutes
ls -lh recordings/yard/
#   2026-08-25_12-32-10-898156.mp4   31M   <- a full 10-minute segment

# 3 — the playback API reports a timespan
curl -s 'http://127.0.0.1:9996/list?path=yard'
#   [{"start":"2026-08-25T12:29:24.278292Z","duration":106.89,"url":"..."},
#    {"start":"2026-08-25T12:32:10.898156Z","duration":618.53,"url":"..."}]
#   Two timespans means a recording gap between them; contiguous 10-minute
#   segments are merged into one. `docker compose stop fakecam`, wait, and
#   start it again to produce one on purpose — see "Timeline, gaps, and
#   coverage" in docs/ARCHITECTURE.md.

# 4 — WHEP negotiates. A bare POST only earns "invalid Content-Type", and
#     OPTIONS returns 204 even for a path with no publisher, so neither proves
#     anything. A real SDP offer does: 201 plus a Location header. This talks
#     to MediaMTX directly, so the Location below is the raw one pointing at
#     itself — the API rewrites it before a browser ever sees it, which is the
#     point of "How live view works" above. The half-open session expires on
#     its own; nothing to clean up.
printf 'v=0\no=- 0 0 IN IP4 0.0.0.0\ns=-\nt=0 0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=ice-ufrag:x\na=ice-pwd:xxxxxxxxxxxxxxxxxxxxxx\na=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\na=setup:actpass\na=mid:0\na=recvonly\na=rtcp-mux\na=rtpmap:96 H264/90000\n' \
  | curl -sD- -o/dev/null -X POST -H 'Content-Type: application/sdp' \
         --data-binary @- http://127.0.0.1:8889/yard/whep \
  | grep -E '^HTTP|^Location'
#   HTTP/1.1 201 Created
#   Location: /yard/whep/9bbb7d50-49aa-4c67-865c-e67a31f530da

curl -s http://127.0.0.1:9997/v3/paths/list              # MediaMTX control API
```

`apps/web` installs with **pnpm**, `apps/api` with **Bun**. This is not a
workspace — two independent installs, wired only by a type-only import.

### Running the tests

```bash
cd apps/api && bun run test          # Vitest — NOT `bun test`, which is Bun's own runner
cd apps/web && pnpm exec playwright test
```

CI runs the unit suite under both `TZ=UTC` and `TZ=Asia/Jakarta`, because a
timezone bug that only appears in one zone is exactly the bug that matters here.

The browser suite needs the whole stack up — Compose, a migrated and seeded
database, and `bun dev` running the API — because it plays real footage off real
disk. It runs one worker at a time on purpose: `e2e/signed-in/gap.spec.ts` stops
the fake camera to create a genuine recording gap, and while it is stopped there
is nothing for the other specs to watch. That spec also **refuses to run** if
`yard` is pulled from a real camera rather than published by `fakecam` — it
would be stopping a container that is not the source of the recording, and would
pass having proved nothing. It skips locally with an explanation and fails on
CI.

Open <http://localhost:3000>.

## Recording settings, and what they cost

The camera's own encoder settings decide storage; the app only records what
arrives. Nothing here is read from `.env` — it is configured in the camera's web
UI — but it is the first thing an install gets wrong, so it is written down.

**The reference install: seven 1080p cameras, 15 fps, H.264, capped VBR at
2 Mbps, on a 4 TB drive — about 136 GB/day and ~22 days of retention.**

| Setting | Value |
|---|---|
| Resolution | 1920×1080 (main stream) |
| Framerate | 15 fps |
| Codec | H.264, High profile |
| Rate control | VBR with a **max bitrate** of 2 Mbps — capped, not unlimited |
| I-frame interval | 30 (2 seconds at 15 fps) |
| Min shutter | ~1/100s in a dim room, so hands do not smear |
| Sub-stream | H.264, low resolution — `doctor` **fails** on anything else |

Storage is `bitrate × 10.8 GB/day` per camera, so for seven cameras a 4 TB drive
(plan for ~3.3 TB, leaving headroom a VBR overshoot cannot eat) buys:

| 1080p H.264 | GB/day/cam | GB/day, all 7 | Retention |
|---|---|---|---|
| 30 fps @ 3.0 Mbps | 32.4 | 227 | 15 days |
| 30 fps @ 2.5 Mbps | 27.0 | 189 | 17 days |
| **15 fps @ 2.0 Mbps** | **21.6** | **151** | **22 days** |
| 15 fps @ 1.8 Mbps | 19.4 | 136 | 24 days |
| 15 fps @ 1.5 Mbps | 16.2 | 113 | 29 days |
| 12 fps @ 1.3 Mbps | 14.0 | 98 | 34 days |

**Why 15 fps rather than 30.** Bitrate is spread across frames, so halving the
framerate doubles the bits each frame gets: 15 fps at 1.8 Mbps is ~120 kbit per
frame against ~83 kbit at 30 fps and 2.5 Mbps — smaller *and* sharper. Human
review needs per-frame clarity — a face, what is in a hand — not smooth motion,
which is why 12–15 fps is what retail installs normally run. If the footage ever
becomes training data for computer vision the trade inverts, because concealment
is a sub-second hand action and you cannot recover frames you did not record.

**Why capped VBR rather than plain VBR.** Unbounded VBR makes the storage
projection a guess, and the failure mode here is a full disk stopping all seven
cameras at once. A ceiling turns the projection into an upper bound. Size the
drive for the cap, not the average — the overnight saving is real but cannot be
banked.

**Why H.264 rather than H.265.** H.265 would roughly halve all of the above, and
`doctor` reports it as a warning rather than a failure, because it is a
portability problem and not a broken install. But a clip is served into a plain
`<video>`, and HEVC decoding is hardware-gated: the same recording plays in
Chrome and Safari on a machine with a decoder and shows a blank frame on one
without. Playwright's bundled Chromium ships no HEVC at all. Disk is the cheaper
resource.

Start at `RECORD_DELETE_AFTER=336h`, run every camera for a week, read the real
`bytesPerHour` off `/health`, then raise it. The table is an estimate; that
measurement is the fact.

At 136 GB/day the drive takes ~50 TB of writes a year, which is at the limit of
what a desktop drive is rated for — so **CMR and surveillance-rated** (WD Purple,
Seagate SkyHawk), never SMR. An SMR write stall surfaces as a gap in the
timeline, which is the one thing this project exists not to hide.
