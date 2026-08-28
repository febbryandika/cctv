'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { BrandMark } from '@/components/brand-mark'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// SMPTE colour bars — the picture a video system shows when it has nothing else
// to show. Decorative, and deliberately not a photograph of somebody's house:
// this is the sign-in page of a camera recorder, and the test pattern says so
// without pretending to be footage.
const BARS_TOP =
  'linear-gradient(90deg,#c0c0c0 0 14.2857%,#c0c000 14.2857% 28.5714%,#00c0c0 28.5714% 42.857%,#00c000 42.857% 57.1428%,#c000c0 57.1428% 71.4285%,#c00000 71.4285% 85.714%,#0000c0 85.714% 100%)'
const BARS_BOTTOM =
  'linear-gradient(90deg,#0000c0 0 14.2857%,#131313 14.2857% 28.5714%,#c000c0 28.5714% 42.857%,#131313 42.857% 57.1428%,#00c0c0 57.1428% 71.4285%,#131313 71.4285% 85.714%,#c0c0c0 85.714% 100%)'
const SCRIM = 'linear-gradient(115deg,oklch(0.14 0.03 265 / 0.86),oklch(0.14 0.03 265 / 0.55))'

// Sign-up is disabled (docs/ARCHITECTURE.md#the-trust-boundary): there is one
// operator account and it comes from `bun run db:seed`, so there is nothing to
// link to from here.
export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const { error } = await authClient.signIn.email({ email, password })

    if (error) {
      setError(error.message ?? 'Could not sign in.')
      setPending(false)
      return
    }

    // refresh() so the proxy re-runs and sees the cookie this request just set.
    router.replace('/')
    router.refresh()
  }

  return (
    // No nav, and none inherited: this route lives in (auth), outside the app
    // shell, so an unauthenticated visitor is never shown a rail full of links
    // they cannot follow. e2e/smoke.spec.ts asserts exactly that.
    <main className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-[#0b0d12] lg:block">
        <div aria-hidden className="absolute inset-0 opacity-50" style={{ background: BARS_TOP }} />
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-[30%] opacity-50"
          style={{ background: BARS_BOTTOM }}
        />
        <div aria-hidden className="absolute inset-0" style={{ background: SCRIM }} />

        <div className="absolute inset-x-12 bottom-12 text-[oklch(0.95_0.008_250)]">
          <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-[oklch(0.14_0.03_265_/_0.6)] px-2.5 py-[5px] text-xs font-semibold tracking-[0.04em]">
            <span aria-hidden className="bg-rec animate-status size-1.5 rounded-full" />
            YARD · RECORDING
          </p>
          <p className="mt-4 max-w-[30ch] text-[26px] leading-[1.25] font-bold tracking-[-0.01em]">
            A recorder that hides its gaps is worse than no recorder.
          </p>
          <p className="mt-2.5 max-w-[52ch] text-sm leading-relaxed text-[oklch(0.85_0.015_250)]">
            Ronda records one ONVIF camera continuously and measures itself. Whatever coverage it
            managed, that is the number you see.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-center p-10">
        <div className="flex w-full max-w-[400px] flex-col gap-6">
          <div className="flex items-center gap-3">
            <BrandMark className="size-10 rounded-lg" iconClassName="size-[22px]" />
            <div>
              <div className="text-xl font-bold tracking-[-0.01em]">Ronda</div>
              <div className="text-muted-foreground text-[13px]">
                Camera live view and recordings
              </div>
            </div>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>

          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-[13px] font-medium">
                Email
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                className="h-10"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className="text-[13px] font-medium">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="h-10"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}

            <Button type="submit" disabled={pending} className="h-10 w-full">
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="bg-card text-muted-foreground rounded-lg border px-4 py-3.5 text-[13px] leading-relaxed">
            Sign-up is disabled. There is one operator account and{' '}
            <span className="text-secondary-foreground font-mono text-xs">bun run db:seed</span> is
            the only thing that can create it, so there is nothing to link to from here.
          </p>
        </div>
      </div>
    </main>
  )
}
