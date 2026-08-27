import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { db } from './db'
import * as schema from './db/schema'

// The web app runs on a different port from this API, so every browser call
// is cross-origin: CORS and Better Auth both have to name the origin, and
// both read it from here. 3100 is Playwright's port (apps/web/playwright.
// config.ts) — omitting it makes the e2e suite fail CORS with a message that
// points nowhere useful.
export const WEB_ORIGINS = (process.env.WEB_ORIGIN ?? 'http://localhost:3000,http://localhost:3100')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

// secret and baseURL come from BETTER_AUTH_SECRET / BETTER_AUTH_URL, which
// Better Auth reads from the environment itself.
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: {
    enabled: true,
    // Sign-up is disabled (docs/ARCHITECTURE.md#the-trust-boundary): the single
    // operator account comes from `bun run db:seed`. This is the library
    // refusing the request — POST /api/auth/sign-up/email returns 400
    // EMAIL_PASSWORD_SIGN_UP_DISABLED — rather than a route we forgot to mount.
    disableSignUp: true,
  },
  trustedOrigins: WEB_ORIGINS,
})
