import { expect, test as setup } from '@playwright/test'
import { API_URL, AUTH_FILE, SEED_EMAIL, SEED_PASSWORD } from './constants'

// Signed in through the API rather than by driving the sign-in form: the form
// itself is walked once, for real, by e2e/journey.spec.ts, and every signed-in
// spec would otherwise pay for it again. The session cookie's domain is
// `localhost` with no port, so one obtained from the API on :3001 is sent to
// the web app on :3100 too.
setup('sign in as the seeded operator', async ({ context }) => {
  const res = await context.request.post(`${API_URL}/api/auth/sign-in/email`, {
    data: { email: SEED_EMAIL, password: SEED_PASSWORD },
  })

  // Loud on purpose. Without the seed - or with the API down - every signed-in
  // spec would otherwise fail at its first assertion and read as a broken
  // feature rather than a harness that was never set up.
  expect(
    res.ok(),
    `sign-in failed (${res.status()}). Is the API running and has \`bun run db:seed\` been run?`,
  ).toBeTruthy()

  await context.storageState({ path: AUTH_FILE })
})
