import { hc, type InferResponseType } from 'hono/client'
import type { AppType } from '../../api/src/index'

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

// Type-only across the app boundary (docs/ARCHITECTURE.md#the-api-surface):
// nothing from apps/api crosses at runtime, and the web app never holds a
// database credential (docs/ARCHITECTURE.md#the-trust-boundary).
//
// It does mean this app's typecheck reads apps/api/src, so apps/api's
// dependencies must be installed for `pnpm typecheck` and `pnpm build` — see
// the bun install step in the web job of .github/workflows/ci.yml.
//
// hono is pinned to the SAME exact version as apps/api. The RPC types are
// structural over hono's internals, so a version skew produces a silently
// empty client rather than an error.
//
// credentials: 'include' is what carries the httpOnly session cookie across the
// origin boundary — the same reason lib/auth-client.ts sets it.
export const api = hc<AppType>(API_URL, { init: { credentials: 'include' } })

export type CamerasResponse = InferResponseType<typeof api.cameras.$get>
export type CameraStatus = CamerasResponse['cameras'][number]
