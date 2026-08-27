import { createAuthClient } from 'better-auth/react'
import { API_URL } from './api'

// The web app never holds a database credential
// (docs/ARCHITECTURE.md#the-trust-boundary) — it talks to Hono, and Hono talks
// to Postgres. baseURL is the API, not this app: Better Auth appends /api/auth
// itself.
//
// credentials: 'include' is what carries the httpOnly session cookie across
// the origin boundary; the API answers with Access-Control-Allow-Credentials.
export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: { credentials: 'include' },
})
