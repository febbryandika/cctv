'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

export function QueryProvider({ children }: { children: ReactNode }) {
  // In state, never at module scope. A module-scope QueryClient in a file that
  // also runs on the server is shared by every request that process handles, so
  // one operator's cached data can be rendered for the next. useState's
  // initialiser runs once per mount, per request.
  const [client] = useState(
    () =>
      new QueryClient({
        // Well under the 10s poll, so a remount refetches rather than showing a
        // status light that is already stale.
        defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
      }),
  )

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
