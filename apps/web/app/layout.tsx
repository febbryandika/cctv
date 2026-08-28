import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { cn } from '@/lib/utils'
import './globals.css'

// Variable font: 400-700 all come from one file, so an explicit `weight` array
// would fetch four static faces for nothing.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

export const metadata: Metadata = {
  title: 'Ronda',
  description: 'Live view and recording for a single ONVIF camera on the local network.',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    // suppressHydrationWarning is required, not defensive: next-themes writes
    // the class onto <html> from a blocking inline script BEFORE React
    // hydrates, so the served markup and the hydrated tree disagree on this one
    // element by design. Without it every page load logs a mismatch.
    <html lang="en" className={cn('font-sans', inter.variable)} suppressHydrationWarning>
      <body className="bg-background text-foreground min-h-dvh antialiased">
        {/* Dark by default: a room with a camera feed in it is usually a dark
            room, and every video surface here is letterboxed against #0b0d12.
            enableSystem is OFF on purpose — the toggle only ever writes 'dark'
            or 'light', so leaving 'system' reachable would add a third state
            nothing in the UI can show or clear. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          themes={['dark', 'light']}
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}
