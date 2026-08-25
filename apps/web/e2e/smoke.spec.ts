import { expect, test } from '@playwright/test'

// The authenticated walk through the nav returns in build order step 12, where
// the harness already needs the API, Postgres and a seeded account — and where
// e2e/.auth/ (already gitignored) holds the storage state.
test('signed out, the app shell redirects to sign-in', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('sign-in renders outside the app shell, with no nav', async ({ page }) => {
  await page.goto('/sign-in')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
})
