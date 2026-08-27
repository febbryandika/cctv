import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { auth, WEB_ORIGINS } from './auth'
import { camerasRoute } from './routes/cameras'
import { liveRoute } from './routes/live'

// Chained so the type carries every route
// (docs/ARCHITECTURE.md#the-api-surface). .route() must stay INSIDE the chain:
// assigning to a local and calling .route() on the next line drops the route
// from AppType silently, with no compile error here and an inscrutable one in
// apps/web. TODO: mount /recordings, /health.
//
// CORS covers every path, not just /api/auth/*: the web app is a separate
// origin, so it will call the media routes cross-origin too. credentials:true
// is what lets the httpOnly session cookie ride along
// (docs/ARCHITECTURE.md#the-trust-boundary).
//
// exposeHeaders is load-bearing for WHEP and fails the same way the Location
// bug (docs/ARCHITECTURE.md#the-whep-proxy) does. A cross-origin response only
// surfaces the six CORS-safelisted headers to script; Location and ETag are not
// among them, so without this the player reads null for the very header the
// proxy exists to rewrite and the handshake dies with nothing obviously wrong
// on either side.
const app = new Hono()
  .use('*', cors({ origin: WEB_ORIGINS, credentials: true, exposeHeaders: ['Location', 'ETag'] }))
  .get('/', (c) => c.json({ ok: true }))
  .all('/api/auth/*', (c) => auth.handler(c.req.raw))
  .route('/cameras', camerasRoute)
  .route('/live', liveRoute)

// The web app imports this type-only to build a typed client via hc<AppType>.
// Nothing crosses this boundary at runtime.
export type AppType = typeof app

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,
}
