import { desc, eq } from 'drizzle-orm'
import { db } from '../db'
import { cameras, streamEvents } from '../db/schema'
import { listPaths, type MediaMtxPath } from './client'

// The up/down audit trail (docs/ARCHITECTURE.md#observability). Every row here
// is what turns an anonymous hole in the timeline into "the camera went down at
// 03:14" - inferCause() reads them and nothing else does.
//
// The last known state lives in MEMORY, and that is the design rather than an
// optimisation. db/index.ts sets idle_timeout: 30 so Neon's Free compute can
// scale to zero after five minutes; a poller that re-read the last event every
// tick would keep it awake ~730 h/month against a 100 CU-hour budget and get
// the project suspended partway through the month. Postgres is therefore
// touched exactly twice at startup and once per transition - which, for a
// camera that stays up, is never again.
//
// process.env and global setInterval, never Bun.*: apps/web typechecks a
// type-only import of ../index, which pulls this file into ITS program, and
// that program has no @types/bun.

// SPEC 2.1 fixes this at 10s, and it is a constant rather than an env var on
// purpose: inferCause() in timeline/coverage.ts documents that a gap shorter
// than this interval is honestly `unknown`, and a configurable interval would
// make that comment a lie for some deployments.
const POLL_INTERVAL_MS = 10_000

type Kind = 'up' | 'down'

export type Transition = { slug: string; kind: Kind; detail: string | null }

// null until the first FULLY successful read. A partial read must leave it null
// so the next tick retries; adopting half a camera list would silently default
// the rest to `up` for the life of the process.
let known: Map<string, Kind> | null = null

// Re-entrancy guard, and it is load-bearing. A cold Neon compute plus
// listPaths()'s 3s timeout can push one poll past the 10s interval, and
// setInterval does not wait. Two overlapping polls would both see known ===
// null, both initialise, both compute the same transition and both insert -
// and stream_events has no unique constraint to catch the duplicate. Set
// synchronously before the first await, which is what makes it work.
let polling = false

// A boolean rather than the timer handle: nothing ever stops the poller - the
// process is the lifecycle (docs/ARCHITECTURE.md#why-a-separate-api-server) -
// so the handle would be dead weight.
let started = false

// Enabled cameras and the last transition recorded for each, read ONCE per
// process. This is what makes an API restart quiet: the poller compares against
// what is already in the table rather than against a blank slate, so restarting
// while the camera is up writes nothing.
//
// N+1: one query for the camera list, then one per camera for its last
// transition. N is the number of cameras, this runs once per process, and the
// app seeds exactly one - so it is two queries at startup and never again. If N
// ever grows the fix is db.selectDistinctOn([streamEvents.cameraSlug], ...)
// ordered by (cameraSlug, desc(at)), which is still two queries; the DISTINCT ON
// ordering rule is not worth learning for one camera. What it must NOT become is
// "read every event and take the first per slug in JS" - that reads a table
// which grows without bound.
async function initialise(): Promise<Map<string, Kind>> {
  const rows = await db
    .select({ slug: cameras.slug })
    .from(cameras)
    .where(eq(cameras.enabled, true))

  const state = new Map<string, Kind>()

  for (const row of rows) {
    const [last] = await db
      .select({ kind: streamEvents.kind })
      .from(streamEvents)
      .where(eq(streamEvents.cameraSlug, row.slug))
      .orderBy(desc(streamEvents.at))
      .limit(1)

    // `up` when there is no history at all. A fresh database plus a camera that
    // is already up then writes nothing, and one that is already down writes a
    // single `down` - which is the interesting half. Defaulting to `down`
    // instead would write a spurious `up` on every first start, and an `up` is
    // not a transition.
    state.set(row.slug, last?.kind ?? 'up')
  }

  return state
}

// Pure: last-known state plus what MediaMTX reports, out come the rows to
// write. No I/O and no clock, which is what lets "transitions only" be tested
// with no mocking at all - the same bargain joinStatus() makes in
// routes/cameras.ts.
//
// It iterates KNOWN, never `paths`, and that is the difference between working
// and a foreign-key violation every ten seconds. `yard_sub` is
// sourceOnDemand: yes, so its `ready` flips every time somebody opens or closes
// the live view; it is a MediaMTX path with no row in `cameras`, and
// stream_events.cameraSlug references cameras.slug. Iterating what MediaMTX
// reports would try to write events for it forever.
export function transitions(known: ReadonlyMap<string, Kind>, paths: MediaMtxPath[]): Transition[] {
  const byName = new Map(paths.map((path) => [path.name, path]))
  const out: Transition[] = []

  for (const [slug, last] of known) {
    const path = byName.get(slug)

    // `ready`, never `online`. MediaMTX reports online: true for an idle
    // on-demand path, so `online` would call a camera that has been down for
    // hours live; it is deliberately absent from the Zod schema in client.ts.
    const kind: Kind = path?.ready ? 'up' : 'down'
    if (kind === last) continue

    // "MediaMTX has forgotten this path" and "the publisher went away" are
    // different failures - the first means the config changed under us - and
    // the detail column exists to say which.
    out.push({
      slug,
      kind,
      detail: path === undefined ? 'path not present in mediamtx' : null,
    })
  }

  return out
}

// One tick. Exported so the tests can drive it directly instead of waiting on
// an interval. Never rejects: an unhandled rejection inside setInterval would
// take the API process down, and a camera poller may not be able to do that.
export async function pollOnce(): Promise<void> {
  if (polling) return
  polling = true

  try {
    if (!known) {
      try {
        known = await initialise()
      } catch (error) {
        // Postgres not up yet, or Neon still cold. Leave known null and try
        // again in ten seconds rather than making a slow database fatal to a
        // process whose other job is serving video.
        console.error('poller: startup read failed -', error)
        return
      }
    }

    let paths: MediaMtxPath[]
    try {
      paths = await listPaths()
    } catch (error) {
      // NOT a `down`. routes/cameras.ts keeps "this camera is down" and "we
      // could not tell" as different facts, and so does this: writing `down`
      // here would blame the camera for the API server's own blindness, and
      // label the resulting gap camera_down on no evidence. The gap reads
      // `unknown`, which SPEC 4.4 calls the interesting one. State is left
      // untouched, so the transition is still detected once MediaMTX answers.
      console.error('poller: control API unreachable -', error)
      return
    }

    // One instant, shared by every row this tick writes, captured after the
    // fetch so it is the moment we actually learned the state.
    //
    // The DETECTION instant, and never readyTime. inferCause() matches a `down`
    // only inside [gap.start, gap.end), and a down written a few seconds late
    // lands just inside the gap it explains - which is why coverage.ts's own
    // comment endorses the lateness. Backdating to readyTime would place it
    // before the gap began, inferCause would decline to match, and the gap
    // would read `unknown` with nothing wrong in any log.
    const at = new Date()

    // Sequentially, each in its own try: one camera's failed write must not
    // abort another's, and a fan-out would open concurrent connections against
    // a pool capped at max: 5.
    for (const { slug, kind, detail } of transitions(known, paths)) {
      try {
        await db.insert(streamEvents).values({ cameraSlug: slug, kind, at, detail })

        // Only after the insert resolves. A failed write leaves the in-memory
        // state where it was, so the next tick retries with a fresh timestamp
        // rather than losing the transition silently - and a permanent failure
        // is a loud line every ten seconds, which beats quietly erasing
        // something the poller actually observed.
        known.set(slug, kind)
        console.log(`poller: ${slug} ${kind}`)
      } catch (error) {
        console.error(`poller: could not record ${slug} ${kind} -`, error)
      }
    }
  } finally {
    polling = false
  }
}

// Module-level and long-lived, which is half the reason this API is its own
// process (docs/ARCHITECTURE.md#why-a-separate-api-server): in Next this would
// be a lifecycle hook plus a globalThis guard to survive HMR. Under
// `bun --watch` an edit restarts the whole process, and initialise() then
// re-reads the last kind from Postgres, so in-memory state comes back
// consistent - editing a file mid-outage cannot produce a duplicate `down`.
export function startPoller(): void {
  // process.env.VITEST, set by the runner itself, is the only thing between a
  // poller and a hung test suite. smoke.test.ts imports ./index and mocks
  // NOTHING, so without this a vitest worker dials MediaMTX, opens a postgres
  // socket to whatever DATABASE_URL resolves to - vitest loads no env file -
  // and then holds an interval that keeps the event loop alive past teardown.
  // A test-runner check in production code is a real cost and this is cheaper
  // than that failure. When the nightly snapshot (build order 11) needs the
  // same guard, move both behind a src/server.ts entrypoint and delete this.
  if (process.env.VITEST) return
  if (started) return
  started = true

  // Immediately, then on the interval: a camera already down at boot should be
  // recorded now rather than in ten seconds.
  void pollOnce()
  setInterval(() => void pollOnce(), POLL_INTERVAL_MS)
}
