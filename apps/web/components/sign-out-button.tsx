'use client'

import { LogOutIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'

/**
 * `icon` for the rail, where the label would crowd the account row; `button`
 * for Settings, where it is the primary action of its card. Same behaviour
 * either way — the label is the only difference.
 */
export function SignOutButton({ appearance = 'button' }: { appearance?: 'button' | 'icon' }) {
  const router = useRouter()

  const signOut = async () => {
    await authClient.signOut()
    router.replace('/sign-in')
    router.refresh()
  }

  if (appearance === 'icon') {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground size-7"
        aria-label="Sign out"
        title="Sign out"
        onClick={signOut}
      >
        <LogOutIcon className="size-[15px]" />
      </Button>
    )
  }

  return (
    <Button variant="outline" size="sm" onClick={signOut}>
      Sign out
    </Button>
  )
}
