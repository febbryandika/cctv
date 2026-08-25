import { NextResponse } from 'next/server'

// TODO(SPEC 4.1): redirect unauthenticated users to /sign-in.
// Pass-through for now so the matcher and the route shape are already in place.
export function middleware() {
  return NextResponse.next()
}

export const config = {
  matcher: ['/', '/recordings/:path*', '/health/:path*'],
}
