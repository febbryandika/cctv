import { and, desc, eq, gte, lt } from 'drizzle-orm'
import { db } from '../db'
import { streamEvents } from '../db/schema'
import type { StreamEvent } from './coverage'

// The poller writes TRANSITIONS only (docs/ARCHITECTURE.md#data), so the events
// inside a window are not the whole story: a camera that went down at 22:00
// yesterday and is still down leaves today's window with no event in it at all,
// and inferCause - which only matches an event inside the gap - would call the
// resulting all-day outage `unknown`. The one gap most worth labelling would be
// the one guaranteed to be mislabelled.
//
// So the state at the window's start is carried forward from the last
// transition before it. That is reading a known fact forward, not inventing a
// cause: if the last thing the poller saw was `down`, the camera was down when
// the window opened.
//
// Lifted out of routes/recordings.ts when the nightly snapshot became the third
// caller. Three copies of the Date -> epoch-ms boundary is three places to get
// the one conversion this project cares about wrong.
export async function loadEvents(slug: string, from: number, to: number): Promise<StreamEvent[]> {
  const rows = await db
    .select({ kind: streamEvents.kind, at: streamEvents.at })
    .from(streamEvents)
    .where(
      and(
        eq(streamEvents.cameraSlug, slug),
        gte(streamEvents.at, new Date(from)),
        lt(streamEvents.at, new Date(to)),
      ),
    )
    .orderBy(streamEvents.at)

  const [previous] = await db
    .select({ kind: streamEvents.kind })
    .from(streamEvents)
    .where(and(eq(streamEvents.cameraSlug, slug), lt(streamEvents.at, new Date(from))))
    .orderBy(desc(streamEvents.at))
    .limit(1)

  // row.at.getTime() is the Date -> epoch-ms conversion, and it happens exactly
  // here. A Date must never reach the rest of timeline/. The `new Date(from)`
  // above is the mirror image and never leaves this function.
  const inWindow: StreamEvent[] = rows.map((row) => ({ kind: row.kind, at: row.at.getTime() }))

  return previous?.kind === 'down' ? [{ kind: 'down', at: from }, ...inWindow] : inWindow
}
