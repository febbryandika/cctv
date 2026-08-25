import { Hono } from 'hono'

// Chained so the type carries every route (SPEC 6). TODO: mount /api/auth/*,
// /cameras, /live, /recordings, /health.
const app = new Hono().get('/', (c) => c.json({ ok: true }))

// The web app imports this type-only to build a typed client via hc<AppType>.
// Nothing crosses this boundary at runtime.
export type AppType = typeof app

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
}
