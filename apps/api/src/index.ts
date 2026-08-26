import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth, WEB_ORIGINS } from './auth'
import { camerasRoute } from './routes/cameras'

// Chained so the type carries every route (SPEC 6). .route() must stay INSIDE
// the chain: assigning to a local and calling .route() on the next line drops
// the route from AppType silently, with no compile error here and an
// inscrutable one in apps/web. TODO: mount /live, /recordings, /health.
//
// CORS covers every path, not just /api/auth/*: the web app is a separate
// origin, so it will call the media routes cross-origin too. credentials:true
// is what lets the httpOnly session cookie ride along (SPEC 15).
const app = new Hono()
  .use('*', cors({ origin: WEB_ORIGINS, credentials: true }))
  .get('/', (c) => c.json({ ok: true }))
  .all('/api/auth/*', (c) => auth.handler(c.req.raw))
  .route('/cameras', camerasRoute)

// The web app imports this type-only to build a typed client via hc<AppType>.
// Nothing crosses this boundary at runtime.
export type AppType = typeof app

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
}
