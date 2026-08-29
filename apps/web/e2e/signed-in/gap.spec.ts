import { expect, test, type Page } from '@playwright/test'
import type { TimelineGap, TimelineResponse } from '@/lib/api'
import { compose, fakecamPrecondition, waitForYard } from '../compose'
import { API_URL } from '../constants'

// Build order step 12, and the assertion the whole project is for: an outage
// becomes a visible hole in the timeline, with the right duration and the right
// cause. Every other spec in this suite asserts that the app shows what WAS
// recorded; this is the only one that asserts it admits what was not.
//
// "A recorder that hides its gaps is worse than no recorder" is the README's
// claim (docs/ARCHITECTURE.md#timeline-gaps-and-coverage). This file is that
// sentence as a test.
//
// It is also the only spec that mutates the machine it runs on - it stops the
// fake camera every other spec shares - which is why playwright.config.ts runs
// the suite with `workers: 1`.

// apps/api/src/timeline/coverage.ts. A hole at or under this is a muxer
// boundary between consecutive segments, not an outage, and is merged away.
const TOLERANCE_MS = 2_000

// How far each edge of the reported gap may sit from the instant MediaMTX
// actually changed state. Justified at the assertion that uses it.
const EDGE_TOLERANCE_MS = 4_000

// How far off a gap's start may be and still be recognised as the one this test
// created. Deliberately much looser than EDGE_TOLERANCE_MS: the search must
// always FIND the gap so the assertion can fail with a real number, rather than
// failing with "no gap found" and hiding the measurement.
const SEARCH_MS = 15_000

// Keep the camera down for at least this long before restarting it, even if the
// poller has already explained the outage.
//
// Without a floor the outage lasts only as long as step 4's poll takes, which
// on a lucky tick is ~3s - technically above TOLERANCE_MS, but close enough to
// it that the gap this test asserts on is barely distinguishable from the muxer
// boundary the module is designed to erase. Twelve seconds is comfortably clear
// of 2s, still shorter than the poller's worst-case 13s explanation, and keeps
// the whole test under a minute.
const MIN_OUTAGE_MS = 12_000

const CAMERA_TZ = process.env.NEXT_PUBLIC_CAMERA_TZ ?? 'Asia/Jakarta'

// Deliberately a SECOND implementation of lib/camera-time.ts rather than an
// import of it. The render boundary is precisely what the UI half of this test
// checks, and a test that reuses the code under test cannot notice the bar
// drawing a gap seven hours from where it belongs.
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: CAMERA_TZ,
  hour: '2-digit',
  minute: '2-digit',
})
const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: CAMERA_TZ })

// page.request, not the `request` fixture: page.request shares the browser
// context's cookie jar, so the storageState session cookie is guaranteed to
// ride along to the API on :3001.
async function readTimeline(page: Page, fromMs: number, toMs: number): Promise<TimelineResponse> {
  const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString())

  const res = await page.request.get(
    `${API_URL}/recordings/yard/timeline?from=${iso(fromMs)}&to=${iso(toMs)}`,
  )
  expect(res.ok(), `GET /recordings/yard/timeline responded ${res.status()}`).toBeTruthy()

  return (await res.json()) as TimelineResponse
}

// The NEAREST gap to the instant the camera stopped, not the first one within
// range. Re-running this test leaves its own gap on the same day, and on a quick
// re-run the previous one can still fall inside SEARCH_MS - `find` would then
// measure the wrong outage and fail with a baffling number.
const nearest = (gaps: TimelineGap[], stoppedAt: number): TimelineGap | null =>
  gaps
    .filter((g) => Math.abs(Date.parse(g.start) - stoppedAt) <= SEARCH_MS)
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.start) - stoppedAt) - Math.abs(Date.parse(b.start) - stoppedAt),
    )[0] ?? null

// The window is chosen here rather than inherited from a calendar day, which is
// what makes every API assertion below immune to camera-local midnight.
async function gapNear(page: Page, stoppedAt: number): Promise<TimelineGap | null> {
  const body = await readTimeline(page, stoppedAt - 10 * 60_000, Date.now())

  return nearest(body.gaps, stoppedAt)
}

// MediaMTX lists a segment only once its first fMP4 part is flushed
// (recordPartDuration: 1s), so for a beat after the camera returns the gap is
// still open and still runs to `now`. Waiting for it to close is what stops the
// arithmetic below being a race against the muxer.
async function closedGap(page: Page, stoppedAt: number, restartedAt: number): Promise<TimelineGap> {
  const deadline = Date.now() + 30_000

  for (;;) {
    const body = await readTimeline(page, stoppedAt - 10 * 60_000, Date.now())
    const gap = nearest(body.gaps, stoppedAt)
    const resumed = body.spans.some((s) => Date.parse(s.start) >= restartedAt - 5_000)

    if (gap && resumed && Date.parse(gap.end) < Date.now() - 2_000) return gap

    if (Date.now() > deadline) {
      throw new Error('the gap never closed after the camera came back')
    }
    await page.waitForTimeout(1_000)
  }
}

let stoppedFakecam = false

test.afterEach(async () => {
  if (!stoppedFakecam) return

  await compose(['start', 'fakecam'])
  // Not fire-and-forget. A run that leaves fakecam stopped poisons every later
  // run on this machine: the next suite finds an hours-long gap and a live view
  // reading NO SIGNAL, with nothing anywhere to say why.
  await waitForYard(true, 60_000)
  stoppedFakecam = false
})

test('an outage becomes a gap in the timeline, with its duration and its cause', async ({
  page,
}) => {
  test.setTimeout(180_000)

  // 1 - Refuse to pass vacuously.
  const blocked = await fakecamPrecondition()
  if (blocked) {
    // On CI a broken fixture is a broken harness, and skipping would let the
    // suite report green having proved nothing - which is the exact dishonesty
    // this test exists to catch the product doing. Locally, pulling from a real
    // camera is a legitimate configuration, so it skips and says so.
    if (process.env.CI) throw new Error(`the gap test cannot run: ${blocked}`)
    test.skip(true, blocked)
  }

  // 2 - Recording is actually running right now, so the outage measured below is
  //     one this test caused. The second half of the anti-vacuity guard.
  //
  //     The question is whether a gap is OPEN, not whether one happened
  //     recently. An open gap runs to window.end, which is `now`, so it is the
  //     one whose end never recedes. Asking the looser question - "no gap in the
  //     last 30s" - would make this test unable to run twice in half a minute,
  //     and with retries: 2 on CI a retry would then fail here rather than on
  //     the thing it was retrying.
  const before = await readTimeline(page, Date.now() - 10 * 60_000, Date.now())

  expect(
    before.spans.length,
    'nothing has been recorded in the last ten minutes - is the fixture publishing?',
  ).toBeGreaterThan(0)
  expect(
    before.gaps.filter((g) => Date.parse(g.end) > Date.now() - 3_000),
    'recording is already interrupted - this test needs a running camera to stop',
  ).toHaveLength(0)

  // 3 - Stop the camera.
  //
  //     `stop`, never `kill`: fakecam is `restart: unless-stopped`, and Docker
  //     exempts only a container an operator explicitly STOPPED. A killed one is
  //     back within a second or two, and a sub-2s hole is exactly what
  //     TOLERANCE_MS erases - the test would then fail with "no gap" and nothing
  //     would say why.
  await compose(['stop', '-t', '5', 'fakecam'])
  stoppedFakecam = true
  const stoppedAt = await waitForYard(false, 30_000)

  // 4 - Wait for the outage to become EXPLICABLE, rather than for a fixed number
  //     of seconds.
  //
  //     The poller ticks every 10s and writes transitions only, so the `down`
  //     row that makes inferCause() answer `camera_down` lands somewhere in
  //     [0, 13s] after the drop - the 10s interval plus listPaths's 3s
  //     AbortSignal.timeout. Polling for the cause makes the wait and the
  //     assertion the same thing, and it typically resolves in 5-13s rather than
  //     the 30s a sleep would have to budget for.
  //
  //     While the camera is down the gap is OPEN - gaps() runs it to
  //     window.end, which is `now` - so it appears after ~2s reading `unknown`
  //     and flips to `camera_down` once the poller catches up. That flip is the
  //     observable.
  await expect
    .poll(async () => (await gapNear(page, stoppedAt))?.cause ?? 'no gap yet', {
      timeout: 45_000,
      intervals: [2_000],
      message:
        'the open gap never became camera_down. Is the API running from src/server.ts? ' +
        'src/index.ts starts no poller, and with no `down` row the gap is honestly `unknown`.',
    })
    .toBe('camera_down')

  // 5 - Bring it back, but not before the outage is unambiguously an outage.
  //     On a lucky poller tick step 4 returns in ~3s, which would leave this
  //     asserting on a gap barely above the tolerance that exists to erase
  //     muxer boundaries.
  const outstanding = MIN_OUTAGE_MS - (Date.now() - stoppedAt)
  if (outstanding > 0) await page.waitForTimeout(outstanding)

  await compose(['start', 'fakecam'])
  const restartedAt = await waitForYard(true, 45_000)
  stoppedFakecam = false

  // 6 - Let the record close, then do the arithmetic.
  const gap = await closedGap(page, stoppedAt, restartedAt)

  const gapStart = Date.parse(gap.start)
  const gapEnd = Date.parse(gap.end)

  // Both EDGES rather than a duration band. That is strictly stronger: it
  // catches "right length, wrong place", which is what a timezone slip or a
  // missing clampToNow looks like.
  //
  // Left edge: gapStart is the end of the last flushed fMP4 part, so at most ~1s
  // before the true stop; stoppedAt comes from a 250ms poll of the control API,
  // so at most ~0.3s after it. Right edge: gapEnd is stamped on the first frame
  // of the resumed segment, and restartedAt carries the same ~0.3s observation
  // lag. Worst case is under 2s either way; 4s is the budget for scheduler noise
  // on a loaded runner.
  //
  // Loose enough to survive CI, tight enough to mean something: every bug worth
  // catching here is orders of magnitude larger. A timezone slip is 7 hours, a
  // missing window clamp is the rest of the day, a lost `down` row is a wrong
  // cause, and a merge-tolerance regression makes the gap vanish entirely.
  expect(
    Math.abs(gapStart - stoppedAt),
    'the gap does not start where the camera stopped',
  ).toBeLessThanOrEqual(EDGE_TOLERANCE_MS)
  expect(
    Math.abs(gapEnd - restartedAt),
    'the gap does not end where the camera came back',
  ).toBeLessThanOrEqual(EDGE_TOLERANCE_MS)

  // The module's own rule, restated at the wire: under 2s this would have been
  // merged away as a muxer boundary and never reported at all.
  expect(gapEnd - gapStart).toBeGreaterThan(TOLERANCE_MS)
  expect(gap.cause).toBe('camera_down')

  // Pins the route's own rounding, which no unit test covers at this boundary.
  expect(gap.durationSec).toBe(Math.round((gapEnd - gapStart) / 1000))

  // 7 - The claim, on screen.
  //
  //     A gap crossing camera-local midnight (17:00 UTC in Asia/Jakarta) is
  //     reported by the DAY-bounded timeline as two gaps, one per day, and
  //     neither has the duration measured above. Steps 2-6 chose their own
  //     window and are immune; only this half is affected, so it is skipped
  //     after the fact rather than the whole test being skipped before it on a
  //     clock reading. The product's core proof never silently skips.
  if (localDay.format(gapStart) !== localDay.format(gapEnd)) {
    test.info().annotations.push({
      type: 'partial',
      description: 'outage straddled camera-local midnight - UI assertions skipped',
    })
    return
  }

  // ?at= is the live view's "Last 5 minutes" jump reused: recordings/page.tsx
  // validates it, resolves the camera-local day from it, and the timeline
  // selects that instant once the spans arrive. The MIDPOINT of the gap, not its
  // start - spans are half-open [start, end), so gap.start is a boundary.
  //
  // A fresh navigation is also the only way to see any of this: the timeline
  // query has staleTime 0 but no refetchInterval, and TransitionStream
  // invalidates ['health'] and ['cameras'] - never ['timeline'].
  const inside = new Date(Math.round((gapStart + gapEnd) / 2)).toISOString()
  await page.goto(`/recordings?at=${encodeURIComponent(inside)}`)
  await expect(page.getByRole('heading', { name: 'Recordings' })).toBeVisible()

  // The bar draws it, and the accessible name says when and why. No testid,
  // because the hit target is a real button with a real name - and that name is
  // the only automated check that the render boundary puts the gap at the right
  // camera-local clock time.
  //
  // .first(): a retried run leaves the previous attempt's gap on the same bar,
  // and two outages a minute apart round to the same HH:MM.
  const label = new RegExp(
    `^Gap, .+, from ${clock.format(gapStart)} to ${clock.format(gapEnd)}, cause: camera down$`,
  )
  await expect(page.getByRole('button', { name: label }).first()).toBeVisible()

  // And it refuses to play what it does not have (SPEC 4.5). ?at= already
  // selected the instant, so this is on screen with no click. NoFootage is the
  // only role="status" on this page - EmptyPlayer deliberately has none.
  await expect(page.getByRole('status')).toContainText('That part of the day is a gap.')
  await expect(page.locator('video')).toHaveCount(0)
})
