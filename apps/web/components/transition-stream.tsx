'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { formatClock } from '@/lib/camera-time'

/**
 * Transitions as they happen, so a drop is visible when it occurs rather than at
 * the next refetch (docs/ARCHITECTURE.md#observability).
 *
 * Mounted in the app shell rather than on the health page: the rail carries a
 * status dot on every screen, and a stream that only ran while /health was open
 * would leave that dot up to ten seconds stale everywhere else — which is the
 * exact staleness this endpoint exists to remove.
 *
 * withCredentials is load-bearing and fails the same silent way `crossOrigin` on
 * the clip player does: the API is a separate origin, and EventSource sends no
 * cookie across one unless it is asked to - the route would answer 401 and the
 * page would simply never update, with nothing in any log.
 *
 * No reconnect logic: EventSource retries on its own, and the polling intervals
 * in lib/queries.ts are the floor underneath it either way.
 */
export function TransitionStream() {
  const queryClient = useQueryClient()

  useEffect(() => {
    // Built through the typed client, so a rename of the route is a compile
    // error here instead of a stream that silently never opens.
    const source = new EventSource(api.health.events.$url().toString(), {
      withCredentials: true,
    })

    source.addEventListener('transition', (event) => {
      const { slug, kind, at } = JSON.parse((event as MessageEvent<string>).data) as {
        slug: string
        kind: 'up' | 'down'
        at: string
      }

      // The toast is the point. A number that quietly changed on a page nobody
      // was looking at is what this endpoint exists to improve on.
      toast(kind === 'down' ? `${slug} went down` : `${slug} is back`, {
        description: formatClock(at),
      })

      void queryClient.invalidateQueries({ queryKey: ['health'] })
      void queryClient.invalidateQueries({ queryKey: ['cameras'] })
    })

    return () => source.close()
  }, [queryClient])

  return null
}
