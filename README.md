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
docker compose up -d                 # MediaMTX + fake camera + postgres
cd apps/api  && bun install && bun run db:migrate && bun run db:seed && bun dev
cd apps/web  && pnpm install && pnpm dev
```

Ports are published to `127.0.0.1` only (SPEC 15). Postgres is on **5439**, not
5432, because a natively-installed Postgres usually owns the standard port —
`.env.example` already points at 5439. Check a live stream with:

```bash
ffprobe -rtsp_transport tcp rtsp://127.0.0.1:8554/yard   # or open it in VLC
curl -s http://127.0.0.1:9997/v3/paths/list              # MediaMTX control API
```

`apps/web` installs with **pnpm**, `apps/api` with **Bun**. This is not a
workspace — two independent installs, wired only by a type-only import.

Open <http://localhost:3000>.
