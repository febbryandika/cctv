'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ComponentProps } from 'react'

// next-themes has been a dependency since the Toaster was installed, but only
// components/ui/sonner.tsx ever read it, so useTheme() always returned the
// 'system' default and the .dark block in globals.css was unreachable. This is
// the provider that was missing.
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
