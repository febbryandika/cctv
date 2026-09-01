'use client'

import { useState } from 'react'
import { Timeline } from '@/components/timeline'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCameras } from '@/lib/queries'

/**
 * Which camera's day you are looking at.
 *
 * The timeline itself has always taken a slug; what was missing was a way to
 * say which. `?camera=` carries it so the live view's "last 5 minutes" and the
 * health page's history bars can link to the camera they are about rather than
 * dropping you on whichever one sorts first.
 */
export function RecordingsBrowser({
  initialSlug,
  today,
  initialDay,
  initialAtMs,
}: {
  initialSlug?: string
  today: string
  initialDay?: string
  initialAtMs?: number
}) {
  const { data, isPending, isError } = useCameras()
  const [picked, setPicked] = useState<string | undefined>(initialSlug)

  if (isPending) {
    return (
      <div className="flex flex-col gap-[18px] px-7 pt-5 pb-8">
        <Skeleton className="h-9 w-[320px] rounded-lg" />
        <Skeleton className="h-[220px] rounded-xl" />
      </div>
    )
  }

  if (isError || data.cameras.length === 0) {
    return (
      <div className="px-7 py-6">
        <p className="text-muted-foreground text-sm">
          {isError
            ? 'Could not reach the API, so there is no camera list to browse.'
            : 'No cameras are configured. Run `bun run db:seed`.'}
        </p>
      </div>
    )
  }

  // A slug that is not in the fleet - a stale link, or a camera that has since
  // been removed - falls back rather than rendering a timeline for a camera the
  // API will 404.
  const slug =
    data.cameras.find((camera) => camera.slug === picked)?.slug ?? (data.cameras[0]?.slug as string)

  return (
    <div className="flex flex-col">
      {/* One camera needs no picker, and drawing a single tab would just be
          furniture. */}
      {data.cameras.length > 1 ? (
        <div className="px-7 pt-5">
          <Tabs value={slug} onValueChange={setPicked}>
            <TabsList>
              {data.cameras.map((camera) => (
                <TabsTrigger key={camera.slug} value={camera.slug}>
                  {camera.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      ) : null}

      {/* key remounts the timeline per camera, which is the point: day, zoom,
          selection and the jumped-to instant are all per-camera state, and
          leaking one camera's scroll position onto another's footage would be
          worse than resetting. It also re-applies initialAtMs, so "the same
          moment on cam3" works. */}
      <Timeline
        key={slug}
        slug={slug}
        today={today}
        initialDay={initialDay}
        initialAtMs={initialAtMs}
      />
    </div>
  )
}
