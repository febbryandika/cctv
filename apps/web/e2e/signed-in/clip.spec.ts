import { expect, test, type Locator } from '@playwright/test'

// Build order step 8, the assertion the phase exists for: a click on a recorded
// part of the timeline plays that moment back.
//
// Needs the whole local stack - the API, Postgres and Docker Compose - because
// it plays real footage off real disk. `playwright.config.ts` starts only
// `next dev`; CI wiring waits for build order step 12 along with the
// stop-the-fake-camera gap test.

// Clicks the centre of an element, which for a timeline span is a wall-clock
// instant halfway through it.
const clickCentre = async (element: Locator) => {
  const box = await element.boundingBox()
  expect(box, 'element has no box to click').not.toBeNull()

  await element.page().mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/recordings')
  await expect(page.getByRole('heading', { name: 'Recordings' })).toBeVisible()
})

test('clicking a recorded position on the timeline plays that moment', async ({ page }) => {
  const span = page.getByTestId('timeline-span').first()

  await expect(
    span,
    'no recorded span today - is the fake camera publishing? `docker compose up -d`',
  ).toBeVisible()

  await clickCentre(span)

  const video = page.locator('video')
  await expect(video).toBeVisible()

  // readyState >= 2 is HAVE_CURRENT_DATA: the browser has decoded a frame at
  // the current position. Anything less and the element is present but empty,
  // which is the failure this whole phase is about.
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2)

  // A finite duration is what proves the proxy asked MediaMTX for format=mp4.
  // The fmp4 default writes mvhd.duration = 0 and this reads Infinity, with the
  // native scrubber unusable - playback that looks fine until you try to seek.
  const duration = await video.evaluate((el: HTMLVideoElement) => el.duration)
  expect(Number.isFinite(duration)).toBe(true)
  expect(duration).toBeGreaterThan(0)

  // Actually advancing, not merely loaded.
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 10_000 })
    .toBeGreaterThan(0)
})

test('the player asks the clip proxy for the instant that was clicked', async ({ page }) => {
  const span = page.getByTestId('timeline-span').first()
  await expect(span).toBeVisible()

  const clip = page.waitForRequest((request) => request.url().includes('/clip?'))
  await clickCentre(span)

  const url = new URL((await clip).url())

  expect(url.pathname).toBe('/recordings/yard/clip')
  expect(url.searchParams.get('duration')).toBe('300')
  // Sent as RFC3339 UTC, never a camera-local wall-clock string
  // (docs/ARCHITECTURE.md#timeline-gaps-and-coverage).
  expect(url.searchParams.get('start')).toMatch(/Z$/)
})

// SPEC 4.5: the click with no footage behind it gets an explanation and a way
// out, never an empty <video>. Driven against the part of today that has not
// happened yet, which exists on every run - unlike a recording gap, which needs
// the fake camera stopped (build order step 9).
test('a click with no footage explains itself and offers the nearest span', async ({ page }) => {
  const notElapsed = page.getByTestId('timeline-not-elapsed')

  await expect(notElapsed).toBeVisible()
  await clickCentre(notElapsed)

  await expect(page.getByRole('status')).toContainText('has not happened yet')
  await expect(page.locator('video')).toHaveCount(0)

  // The way out, and it has to actually work.
  const offer = page.getByRole('button', { name: /^Play from/ }).first()
  await expect(offer).toBeVisible()
  await offer.click()

  await expect(page.locator('video')).toBeVisible()
})
