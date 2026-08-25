import Link from 'next/link'
import type { ReactNode } from 'react'
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
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  )
}
