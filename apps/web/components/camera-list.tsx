'use client'

import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type CameraStatus } from '@/lib/api'
import { cn } from '@/lib/utils'

// This is a status light, not a stream — the picture arrives over WHEP (SPEC 9)
// — so polling only has to be fast enough that an operator notices a drop.
// refetchIntervalInBackground stays off (the default), so a hidden tab stops
// polling instead of hammering the API all night.
const REFETCH_MS = 10_000

export function CameraList() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['cameras'],
    queryFn: async ({ signal }) => {
      const res = await api.cameras.$get(undefined, { init: { signal } })
      // Thrown so an expired session surfaces as an error state rather than a
      // blank card.
      if (!res.ok) throw new Error(`GET /cameras responded ${res.status}`)
      return res.json()
    },
    refetchInterval: REFETCH_MS,
  })

  if (isPending) return <Skeleton className="aspect-video w-full max-w-md rounded-xl" />

  // The API being unreachable is a different fact from a camera being down, and
  // the page says which. Either way it renders — it never throws.
  if (isError) {
    return (
      <p className="text-muted-foreground text-sm">
        Could not reach the API. Retrying every {REFETCH_MS / 1000} seconds.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {data.mediamtx === 'down' ? (
        <p className="text-muted-foreground text-sm">
          MediaMTX is not responding, so every camera reads as offline — a camera that cannot be
          confirmed up is not up.
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {data.cameras.map((camera) => (
          <CameraCard key={camera.slug} camera={camera} />
        ))}
      </div>
    </div>
  )
}

function CameraCard({ camera }: { camera: CameraStatus }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{camera.name}</CardTitle>
        <CardDescription>{camera.slug}</CardDescription>
        <CardAction>
          {/* No `success` variant in the radix-nova registry, and editing
              badge.tsx would drift it from the registry — a dot carries the
              state instead. */}
          <Badge variant={camera.online ? 'outline' : 'destructive'}>
            <span
              aria-hidden
              className={cn(
                'size-1.5 rounded-full',
                camera.online ? 'bg-emerald-500' : 'bg-destructive',
              )}
            />
            {camera.online ? 'Online' : 'Offline'}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {/* TODO(SPEC 9, build order 5): WHEP player against `${camera.slug}_sub`. */}
        <div className="bg-muted ring-foreground/10 flex aspect-video items-center justify-center rounded-lg ring-1">
          <p className="text-muted-foreground text-xs">Player lands with the WHEP proxy</p>
        </div>
      </CardContent>
    </Card>
  )
}
