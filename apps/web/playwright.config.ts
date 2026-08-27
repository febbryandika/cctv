import { defineConfig, devices } from '@playwright/test'
import { AUTH_FILE } from './e2e/constants'

// A dedicated port, not Next's default 3000. Playwright's reuseExistingServer
// will happily attach to whatever already holds a port, so sharing 3000 means
// the suite can silently run against an unrelated app.
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    // Signs in once through the API and writes the session cookie to
    // e2e/.auth/, so the specs that need an operator do not each drive the
    // sign-in form.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },

    // Two projects rather than one, because the suite needs both states: the
    // smoke specs assert what an unauthenticated visitor sees, and asserting
    // that with a session loaded would test nothing.
    {
      name: 'chromium',
      testIgnore: ['**/signed-in/**', '**/auth.setup.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-signed-in',
      testMatch: '**/signed-in/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'], storageState: AUTH_FILE },
      dependencies: ['setup'],
    },
  ],
  // Only the web app. The signed-in specs also need the Hono API, Postgres and
  // Docker Compose, which are a developer's `docker compose up -d` rather than
  // something this config can conjure - CI wiring waits for build order step 12.
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
