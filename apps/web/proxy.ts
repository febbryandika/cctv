import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getSessionCookie } from 'better-auth/cookies'

// Next 16 renamed the `middleware` file convention to `proxy`; SPEC 3 predates
// that. Same feature, same matcher, new required export name.
//
// This check is OPTIMISTIC and deliberately so: it reads the cookie without
// validating it, to spare every navigation a round-trip to the API. It is a
// redirect for humans, not the gate. The gate is the API, which resolves the
// session server-side on every route (SPEC 4.1) and is the only thing that can
// reach MediaMTX at all (SPEC 15). A forged cookie gets you a page that then
// fails every request it makes.
//
// It works in development because cookies ignore ports: the API sets the
// cookie on `localhost` and this app, on another port of `localhost`, is sent
// it. When the two processes move to separate hosts (SPEC 5.1) that stops
// being true and this needs revisiting along with the cookie's domain.
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next()

  const signIn = new URL('/sign-in', request.url)
  return NextResponse.redirect(signIn)
}

export const config = {
  matcher: ['/', '/recordings/:path*', '/health/:path*'],
}
