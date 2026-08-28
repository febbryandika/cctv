import { expect, test, type Locator } from '@playwright/test'

// The timeline gained a zoomable window, and the click-to-play contract in
// clip.spec.ts is only proved at the DEFAULT whole-day zoom. This is the other
// half: the same click still resolves to the same instant once the view has
// been narrowed, because span rectangles are clipped to the view rather than
// allowed to overflow it.
//
// Needs the whole local stack for the same reason clip.spec.ts does - it plays
// real footage off real disk.

const centreOf = async (element: Locator) => {
  const box = await element.boundingBox()
  expect(box, 'element has no box').not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/recordings')
  await expect(page.getByRole('heading', { name: 'Recordings' })).toBeVisible()
})

test('the timeline opens on the whole day and returns to it', async ({ page }) => {
  const zoom = page.getByTestId('timeline-zoom')

  // A fresh load must be the whole day: nothing persists the view to the URL or
  // to storage, which is what makes clip.spec.ts's geometry predictable.
  await expect(zoom).toHaveText('24h')

  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(zoom).not.toHaveText('24h')

  // `0` is advertised in the shortcut sheet, so it has to work.
  await page.keyboard.press('0')
  await expect(zoom).toHaveText('24h')
})

test('a zoomed-in span still plays the instant that was clicked', async ({ page }) => {
  const span = page.getByTestId('timeline-span').first()
  await expect(
    span,
    'no recorded span today - is the fake camera publishing? `docker compose up -d`',
  ).toBeVisible()

  // Zoom under the cursor, anchored inside the span, so that span is guaranteed
  // to still intersect the view afterwards.
  const anchor = await centreOf(span)
  await page.mouse.move(anchor.x, anchor.y)
  await page.mouse.wheel(0, -120)

  await expect(page.getByTestId('timeline-zoom')).not.toHaveText('24h')

  const zoomed = page.getByTestId('timeline-span').first()
  await expect(zoomed).toBeVisible()

  const clip = page.waitForRequest((request) => request.url().includes('/clip?'))
  const target = await centreOf(zoomed)
  await page.mouse.click(target.x, target.y)

  const url = new URL((await clip).url())
  expect(url.pathname).toBe('/recordings/yard/clip')
  expect(url.searchParams.get('duration')).toBe('300')
  expect(url.searchParams.get('start')).toMatch(/Z$/)

  await expect(page.locator('video')).toBeVisible()
})
