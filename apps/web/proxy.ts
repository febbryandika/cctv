import { NextResponse } from 'next/server'

// Next 16 renamed the `middleware` file convention to `proxy`; SPEC 3 predates
// that. Same feature, same matcher, new required export name.
//
// TODO(SPEC 4.1): redirect unauthenticated users to /sign-in.
// Pass-through for now so the matcher and the route shape are already in place.
export function proxy() {
  return NextResponse.next()
}

export const config = {
  matcher: ['/', '/recordings/:path*', '/health/:path*'],
}
