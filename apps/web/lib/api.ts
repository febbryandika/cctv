// TODO(SPEC 6): typed Hono RPC client.
//
//   import { hc } from 'hono/client'
//   import type { AppType } from '../../api/src/index'   // type-only
//
// Deliberately not wired yet: the cross-app type import would make this app's
// typecheck depend on apps/api/node_modules being installed. It lands with the
// first route that is actually called.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
