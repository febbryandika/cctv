# Ronda

> **TODO:** one-line pitch, plus a GIF — live view, then scrubbing the timeline
> into a recorded gap and back.

Local CCTV live view and recording for a single ONVIF camera.

---

## The problem

> **TODO (2 sentences):** browsers cannot play RTSP, and a recorder that hides
> its gaps is worse than no recorder.

## Architecture

> **TODO:** diagram — camera → MediaMTX → Hono → Next — plus a short
> **"Why a separate API server?"** paragraph. An unexplained second process
> reads as overengineering; an explained one reads as judgment.

```
camera (ONVIF/RTSP) → MediaMTX (loopback only) → Hono API (Bun) → Next.js web
                            ↓
                      ./recordings/
```

## How live view works

The browser cannot play RTSP — that is a protocol mismatch, not a library gap —
so something has to translate. MediaMTX serves the camera over WebRTC, and the
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

Each camera is two MediaMTX paths: `yard` — high resolution, recorded
continuously, `sourceOnDemand: no` — and `yard_sub` — low bitrate, H.264, pulled
only while someone is watching, never recorded.

Live view reads `yard_sub`, so watching costs almost nothing and **a viewer can
never disturb the recording** ([the two
paths](docs/ARCHITECTURE.md#the-media-pipeline)). That is enforced by the API
rather than asked of the client: `/live/yard/whep` resolves to `yard_sub`, and
`/live/yard_sub/whep` is an unknown camera. There is no request shape that
reaches the recorded path.

## How playback works

> **TODO:** segments, timespans, and who does the stitching — MediaMTX, not us,
> with the reason.

## Coverage

> **TODO:** the real number from `bun run measure`, with the method and the
> 2-second merge tolerance.

## What I deliberately didn't build

> **TODO:** the non-goals with one-line reasons each. Highest-signal section in
> the file.

## Local setup

```bash
git clone <repo> && cd cctv
cp .env.example .env                 # camera IP, ONVIF password, DATABASE_URL
mkdir -p recordings                  # bind-mount target, owned by you not root
(cd apps/api && bun run render:mediamtx)   # .env → mediamtx.yml (generated)
docker compose up -d                 # MediaMTX + fake camera + postgres
cd apps/api  && bun install && bun run db:migrate && bun run db:seed && bun dev
cd apps/web  && pnpm install && pnpm dev
```

`mediamtx.yml` is **generated** from the tracked `mediamtx.template.yml` and is
not itself tracked: the camera's RTSP path is
`rtsp://<ip>:5543/<md5(ONVIF_PASSWORD)>/live/channel0`, so committing the config
would commit a password hash
([why](docs/ARCHITECTURE.md#the-trust-boundary)). Re-run the render step after
changing `CAMERA_IP` or `ONVIF_PASSWORD`. If the file is missing,
`docker compose up` fails rather than starting MediaMTX on its defaults — which
would quietly mean HLS on, RTMP on, and nothing recorded.

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

Four checks say the media layer is actually working, not merely running:

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

Open <http://localhost:3000>.
