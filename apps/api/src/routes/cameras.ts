import { Hono } from 'hono'
import { db } from '../db'
import { cameras } from '../db/schema'
import { listPaths, type MediaMtxPath } from '../mediamtx/client'
import { requireSession, type SessionEnv } from '../middleware/session'

export type CameraRow = { slug: string; name: string; enabled: boolean }

// Pure: rows plus paths in, response out. `paths === null` means the control
// API could not be asked at all — which is the case that has to keep working,
// and this signature is what makes it testable with no network and no mocking.
export function joinStatus(rows: CameraRow[], paths: MediaMtxPath[] | null) {
  const byName = new Map((paths ?? []).map((path) => [path.name, path]))

  return {
    // "this camera is down" and "we could not tell" are different facts, and
    // saying which is the entire point of this project
    // (docs/ARCHITECTURE.md#timeline-gaps-and-coverage, #observability). Both
    // still render offline.
    mediamtx: paths === null ? ('down' as const) : ('up' as const),

    // Disabled cameras are returned, not filtered. A camera that silently
    // vanishes from the list is exactly the kind of quiet lie the timeline
    // (docs/ARCHITECTURE.md#timeline-gaps-and-coverage) is about.
    cameras: rows.map((row) => {
      // The camera row's slug IS the MediaMTX path name, and it is the MAIN
      // recorded path. Not <slug>_sub: the sub-stream is sourceOnDemand, so it
      // is legitimately not-ready whenever nobody is watching, and reporting
      // that as "offline" would call a healthy camera down.
      const path = byName.get(row.slug)

      // `ready`, never `online`. MediaMTX reports online:true for an idle
      // on-demand path — yard_sub sits at online:true with a zero-value
      // onlineTime while nothing is connected — so `online` would report a
      // camera that has been down for hours as live.
      const online = path?.ready ?? false

      return {
        slug: row.slug,
        name: row.name,
        enabled: row.enabled,
        online,
        // Epoch ms UTC (docs/ARCHITECTURE.md#timeline-gaps-and-coverage).
        // Returned but not rendered yet: formatting it means camera-local time
        // and the web app has no camera timezone, so browser-local formatting
        // would plant a timezone bug in exactly the place that section warns
        // about.
        readyAt: online ? (path?.readyTime ?? null) : null,
      }
    }),
  }
}

export const camerasRoute = new Hono<SessionEnv>().get('/', requireSession, async (c) => {
  // Columns named one by one, not select(): rtsp_main and rtsp_sub are the
  // camera's stream URLs and therefore carry its credentials
  // (docs/ARCHITECTURE.md#the-trust-boundary), so a select() here would put a
  // password one JSON.stringify away from the browser. Naming them keeps the
  // secret inside Postgres rather than trusting a later hand-written
  // projection.
  const rows = await db
    .select({ slug: cameras.slug, name: cameras.name, enabled: cameras.enabled })
    .from(cameras)
    .orderBy(cameras.name)

  // A MediaMTX that cannot be reached must not take the page down with it: the
  // camera reads offline and the operator is told why. One catch, and it is the
  // whole degradation story.
  const paths = await listPaths().catch((error: unknown) => {
    console.error('cameras: control API unreachable -', error)
    return null
  })

  return c.json(joinStatus(rows, paths))
})
