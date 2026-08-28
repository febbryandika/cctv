'use client'

import { TriangleAlertIcon } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Shortcuts } from '@/components/shortcuts'
import { ThemeToggle } from '@/components/theme-toggle'
import { WibClock } from '@/components/wib-clock'
import { Button } from '@/components/ui/button'
import { CAMERA_TZ } from '@/lib/camera-time'
import { isActive, NAV } from '@/lib/nav'
import { CAMERAS_REFETCH_MS, useCameras } from '@/lib/queries'
import { cn } from '@/lib/utils'

// The title and the sentence under it, per route. It lives here rather than in
// each page because the header is now shared chrome — but the STRINGS are still
// the ones the pages used to own, and /recordings must keep reading exactly
// "Recordings": e2e/signed-in/clip.spec.ts locates the page by that heading.
type PageCopy = { title: string; kicker: string }

const LIVE: PageCopy = {
  title: 'Live',
  kicker:
    'Sub-second WebRTC off the sub-stream, so watching never disturbs the recording. Status polls every 10 seconds.',
}

const PAGES: Record<string, PageCopy> = {
  '/': LIVE,
  '/recordings': {
    title: 'Recordings',
    kicker: `What was actually recorded, in ${CAMERA_TZ.replace('_', ' ')} time. Gaps are shown as gaps, never smoothed over.`,
  },
  '/health': {
    title: 'Health',
    kicker:
      'Camera status, disk headroom and the coverage record. Transitions arrive live; the rest refreshes every 30 seconds.',
  },
  '/settings': {
    title: 'Settings',
    kicker: 'How this instance is configured, and what the last diagnostic run reported.',
  },
}

export function AppHeader() {
  const pathname = usePathname()
  const cameras = useCameras()

  // Nested routes fall back to their section, and anything unrecognised to
  // Live — the app has four screens and no dynamic segments, so this is a
  // guard rather than a case that happens.
  const page = PAGES[pathname] ?? PAGES[`/${pathname.split('/')[1]}`] ?? LIVE

  return (
    <>
      <header className="flex shrink-0 items-center gap-4 border-b px-5 py-4 sm:px-7">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-[-0.01em]">{page.title}</h1>
          <p className="text-muted-foreground mt-0.5 text-[13px]">{page.kicker}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Below md the rail is hidden, so the nav has to live somewhere. It
              is icons only because the header already carries the page title,
              and it is never rendered on /sign-in — that route is in (auth),
              outside this shell, and e2e/smoke.spec.ts asserts it has no nav. */}
          <nav className="flex items-center gap-1 md:hidden">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.label}
                aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                className={cn(
                  'flex size-8 items-center justify-center rounded-md border',
                  isActive(pathname, item.href)
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                <item.icon className="size-4" />
              </Link>
            ))}
          </nav>
          <span className="hidden sm:block">
            <WibClock />
          </span>
          <Shortcuts />
          <ThemeToggle />
        </div>
      </header>

      {/* The API being unreachable is a different fact from a camera being down,
          and the app says which (docs/ARCHITECTURE.md#observability). It is a
          banner rather than a replaced page because everything already
          rendered is still the last thing the API actually answered — stale,
          but not wrong, and better than a blank screen. */}
      {cameras.isError ? (
        <div className="bg-destructive/12 flex shrink-0 items-center gap-2.5 border-b px-7 py-2.5">
          <TriangleAlertIcon className="text-destructive size-4 shrink-0" aria-hidden />
          <p role="alert" className="text-[13px]">
            Could not reach the API. Retrying every {CAMERAS_REFETCH_MS / 1000} seconds — figures
            below are the last ones it answered.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => void cameras.refetch()}
          >
            Retry now
          </Button>
        </div>
      ) : null}
    </>
  )
}
