import { expect, test } from '@playwright/test'
import { SEED_EMAIL, SEED_PASSWORD } from './constants'
import { clickCentre } from './helpers'

// Build order step 12: the whole product in one walk. Sign in, watch the camera
// live, open the timeline, click a recorded moment, watch it play.
//
// Deliberately NOT under e2e/signed-in/. That project loads a storageState
// session, and driving the sign-in form while already holding a session proves
// nothing about signing in. This is the only test that exercises the form, the
// cookie Better Auth issues for it, and proxy.ts letting the redirect through.
//
// Deliberately coarse, too. e2e/signed-in/clip.spec.ts already covers the clip
// CONTRACT - the finite duration that proves format=mp4, the exact query the
// proxy is asked for, the 409 with a nearest span. Re-asserting any of that here
// would only make one failure fail twice. This spec ends at "moving pictures".
test('sign in, watch live, open recordings, play a recorded moment', async ({ page }) => {
  test.setTimeout(90_000)

  await page.goto('/')
  await expect(page).toHaveURL(/\/sign-in$/)

  await page.getByLabel('Email').fill(SEED_EMAIL)
  await page.getByLabel('Password').fill(SEED_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { name: 'Live', level: 1 })).toBeVisible()
  const landedAt = Date.now()

  // The element is display:none until the WHEP handshake reports connected
  // (components/live-player.tsx), so visibility IS the connection gate - there
  // is no need to read the LIVE chip to know signalling finished.
  // Scoped to one tile. The live page renders a player per camera, so a bare
  // locator('video') is a strict-mode violation the moment there is more than
  // one - and the camera this journey is about is `yard`, the one CI gates on.
  const video = page.getByTestId('camera-yard').locator('video')
  await expect(video, 'live view never connected').toBeVisible({ timeout: 5_000 })

  // A frame the compositor actually PRESENTED.
  //
  // readyState and the loadeddata event can both be satisfied by a track that
  // negotiated and decoded nothing - the exact failure the player has a
  // "connected but this browser decoded no video" banner for - and
  // requestVideoFrameCallback cannot. It is also the same instrument the player
  // uses for its own time-to-first-frame number, so the test and the product
  // agree on what "first frame" means.
  //
  // The budget is what is LEFT of five seconds since landing on Live, so this
  // asserts the claim end to end rather than five seconds after the handshake.
  const budget = Math.max(500, 5_000 - (Date.now() - landedAt))
  const frame = await video.evaluate(
    (el: HTMLVideoElement, ms) =>
      new Promise<{ width: number; height: number } | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), ms)
        el.requestVideoFrameCallback((_now, metadata) => {
          clearTimeout(timer)
          resolve({ width: metadata.width, height: metadata.height })
        })
      }),
    budget,
  )

  expect(frame, 'live view presented no decoded video frame within five seconds').not.toBeNull()
  expect(frame!.width).toBeGreaterThan(0)
  expect(frame!.height).toBeGreaterThan(0)

  // The operator-visible half of the same fact, read off the page rather than
  // from config.
  await expect(page.getByTestId('camera-yard').getByText('LIVE', { exact: true })).toBeVisible()

  // Navigate by the rail, as an operator would, rather than by URL.
  //
  // getByRole('navigation') is ambiguous on a signed-in page - the rail plus the
  // icon row the header shows below md - but the LINK is not: the header's copy
  // is md:hidden and the rail is hidden md:flex, so at this viewport exactly one
  // of them is in the accessibility tree.
  await page.getByRole('link', { name: 'Recordings' }).click()
  await expect(page.getByRole('heading', { name: 'Recordings' })).toBeVisible()

  const span = page.getByTestId('timeline-span').first()
  await expect(
    span,
    'the timeline drew no recorded span - is the fake camera publishing? `docker compose up -d`',
  ).toBeVisible()

  await clickCentre(span)

  const clip = page.locator('video')
  await expect(clip).toBeVisible()

  // Actually advancing, not merely present. The contract behind it belongs to
  // clip.spec.ts.
  await expect
    .poll(() => clip.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 20_000 })
    .toBeGreaterThan(0)
})
