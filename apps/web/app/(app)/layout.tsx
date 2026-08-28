import type { ReactNode } from 'react'
import { AppHeader } from '@/components/app-header'
import { AppRail } from '@/components/app-rail'
import { QueryProvider } from '@/components/query-provider'
import { TransitionStream } from '@/components/transition-stream'

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    // h-screen with the scroll INSIDE the main column, not on the body: the
    // live view is a video frame sized to the space that is left, and a page
    // that scrolls as a whole has no such space to give it.
    <div className="flex h-dvh overflow-hidden">
      {/* Scoped to this group, not the root layout: /sign-in lives in (auth)
          and queries nothing, so it stays free of an extra client boundary.
          This layout stays a server component — a server layout may render a
          client component and pass server-rendered children through it.

          It wraps the rail as well as the page now: the rail reads camera
          status and disk headroom on every screen, so it needs the same client
          as the pages do, and a second QueryProvider would give it a second
          cache polling the same two endpoints. */}
      <QueryProvider>
        <AppRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <AppHeader />
          <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>
        </div>
        {/* Renders nothing; it is here for the subscription. */}
        <TransitionStream />
      </QueryProvider>
    </div>
  )
}
