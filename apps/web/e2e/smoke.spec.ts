import { expect, test } from '@playwright/test'

test('the app shell renders and its nav links resolve', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Live' })).toBeVisible()

  for (const [label, heading] of [
    ['Recordings', 'Recordings'],
    ['Health', 'Health'],
  ] as const) {
    await page.getByRole('navigation').getByRole('link', { name: label }).click()
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
  }
})

test('sign-in renders outside the app shell, with no nav', async ({ page }) => {
  await page.goto('/sign-in')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
})
