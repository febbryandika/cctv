import Link from 'next/link'
import type { ReactNode } from 'react'
import { QueryProvider } from '@/components/query-provider'
import { SignOutButton } from '@/components/sign-out-button'

const NAV = [
  { href: '/', label: 'Live' },
  { href: '/recordings', label: 'Recordings' },
  { href: '/health', label: 'Health' },
] as const

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-6 px-4">
          <Link href="/" className="font-semibold tracking-tight">
            Ronda
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto">
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {/* Scoped to this group, not the root layout: /sign-in lives in (auth)
            and queries nothing, so it stays free of an extra client boundary.
            This layout stays a server component — a server layout may render a
            client component and pass server-rendered children through it. */}
        <QueryProvider>{children}</QueryProvider>
      </main>
    </div>
  )
}
