'use client'

import { MoonIcon, SunIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <Button
      variant="outline"
      size="icon"
      className="size-8"
      // A stable label and BOTH icons in the markup, switched by the same
      // `dark:` variant every other component uses. The alternative — reading
      // the theme during render — cannot work: the server does not know which
      // class next-themes' inline script is about to write, so it either
      // mismatches on hydration or renders an empty square until an effect
      // runs. resolvedTheme is read in the handler instead, always after mount.
      aria-label="Toggle theme"
      title="Theme (T)"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <SunIcon className="hidden size-[15px] dark:block" />
      <MoonIcon className="size-[15px] dark:hidden" />
    </Button>
  )
}
