import { expect, test } from '@playwright/test'

// These two assert what an unauthenticated visitor sees, so they run without a
// session. The authenticated walk — signing in through this very form and
// carrying on to live view and playback — is e2e/journey.spec.ts.
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
