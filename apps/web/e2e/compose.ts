import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from '@playwright/test'

const run = promisify(execFile)

// docker-compose.yml lives at the repo root, and `playwright test` may be
// invoked from apps/web or from the root, so cwd cannot be trusted. Neither can
// __dirname or import.meta.dirname - which of the two exists depends on how
// Playwright transpiled this file. project.testDir is absolute and is always
// apps/web/e2e.
const repoRoot = () => path.resolve(test.info().project.testDir, '..', '..', '..')

export const compose = (args: string[]) =>
  run('docker', ['compose', ...args], { cwd: repoRoot(), timeout: 90_000 })

const MEDIAMTX_URL = process.env.MEDIAMTX_API_URL ?? 'http://127.0.0.1:9997'

type MtxPath = {
  name: string
  ready: boolean
  source: { type: string } | null
}

async function yardPath(): Promise<MtxPath | null> {
  // Straight to the control API rather than through the Hono proxy: this is the
  // harness asking about its own fixture, and /cameras deliberately does not
  // expose `source` - it would leak the configured RTSP URL, which is a
  // credential (docs/ARCHITECTURE.md#the-trust-boundary).
  const res = await fetch(`${MEDIAMTX_URL}/v3/paths/list`)
  if (!res.ok) throw new Error(`mediamtx /v3/paths/list responded ${res.status}`)

  const body = (await res.json()) as { items: MtxPath[] }
  return body.items.find((item) => item.name === 'yard') ?? null
}

/**
 * Blocks until MediaMTX reports `yard` in the wanted state, and answers with the
 * instant it first read it.
 *
 * That instant - not the moment `docker compose` returned - is what a gap gets
 * measured against. `docker compose stop` blocks for ffmpeg's SIGTERM grace and
 * `start` returns before the publisher has connected, so neither is a clock.
 */
export async function waitForYard(ready: boolean, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const yard = await yardPath().catch(() => null)
    if ((yard?.ready ?? false) === ready) return Date.now()

    if (Date.now() > deadline) {
      throw new Error(`mediamtx never reported yard ready=${ready} within ${timeoutMs} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/**
 * Why `docker compose stop fakecam` might not interrupt anything, or null.
 *
 * `yard` can be fed two ways. Compose's default is `publisher`, and fakecam
 * PUSHES to it - so stopping fakecam stops the recording, which is the entire
 * premise of gap.spec.ts. But .env may set MTX_PATHS_YARD_SOURCE to a real
 * camera, and then MediaMTX PULLS: fakecam is irrelevant, stopping it changes
 * nothing at all, and a loosely written test would report green having proved
 * nothing. That is the exact dishonesty this product exists to prevent, so it
 * is worth refusing to run over.
 */
export async function fakecamPrecondition(): Promise<string | null> {
  let yard: MtxPath | null

  try {
    yard = await yardPath()
  } catch (error) {
    return `MediaMTX is not answering on ${MEDIAMTX_URL} (${String(error)}) - \`docker compose up -d\`.`
  }

  if (!yard) {
    return '`yard` is not configured in MediaMTX. Run `cd apps/api && bun run render:mediamtx`, then `docker compose up -d`.'
  }

  if (!yard.ready) {
    return '`yard` is not recording, so there is nothing to interrupt - `docker compose up -d fakecam`.'
  }

  // rtspSession means something is publishing INTO us, which is fakecam.
  // rtspSource means we are pulling from a camera. The distinction is the whole
  // precondition, and it is not guessable - a publishing fixture reports
  // `rtspSession`, never the literal `publisher` that appears in the config.
  if (yard.source?.type !== 'rtspSession') {
    return (
      `\`yard\` is PULLED (source.type=${yard.source?.type ?? 'null'}), not published by fakecam. ` +
      'Stopping fakecam cannot interrupt a stream MediaMTX pulls for itself. ' +
      'Set CAMERA_YARD_RTSP_MAIN=publisher in .env, then ' +
      '`cd apps/api && bun run render:mediamtx` and `docker compose up -d`.'
    )
  }

  return null
}
