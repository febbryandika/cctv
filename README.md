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

> **TODO:** WHEP in five lines, and why WebRTC over HLS (the latency floor is
> 0.5s vs 8s).

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
would commit a password hash (SPEC 15). Re-run the render step after changing
`CAMERA_IP` or `ONVIF_PASSWORD`. If the file is missing, `docker compose up`
fails rather than starting MediaMTX on its defaults — which would quietly mean
HLS on, RTMP on, and nothing recorded.

Ports are published to `127.0.0.1` only (SPEC 15). Postgres is on **5439**, not
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
#   start it again to produce one on purpose (SPEC 8, 11).

# 4 — WHEP negotiates. A bare POST only earns "invalid Content-Type", and
#     OPTIONS returns 204 even for a path with no publisher, so neither proves
#     anything. A real SDP offer does: 201 plus the Location header the API
#     will later have to rewrite (SPEC 9). The half-open session expires on
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
