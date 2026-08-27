import { expect, test as setup } from '@playwright/test'
import { API_URL, AUTH_FILE } from './constants'

// Sign-up is disabled (SPEC 4.1); the single operator comes from
// `bun run db:seed`, so these are the seeded credentials rather than a fixture
// this file creates. .env.example ships them and the README repeats them.
const EMAIL = process.env.SEED_OPERATOR_EMAIL ?? 'operator@ronda.local'
const PASSWORD = process.env.SEED_OPERATOR_PASSWORD ?? 'ronda-operator'

// Signed in through the API rather than by driving the sign-in form: the form
// is already covered by smoke.spec.ts, and every signed-in spec would otherwise
// pay for it again. The session cookie's domain is `localhost` with no port, so
// one obtained from the API on :3001 is sent to the web app on :3100 too.
setup('sign in as the seeded operator', async ({ context }) => {
  const res = await context.request.post(`${API_URL}/api/auth/sign-in/email`, {
    data: { email: EMAIL, password: PASSWORD },
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
