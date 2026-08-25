import { defineConfig } from 'vitest/config'

// TZ is deliberately NOT set here. SPEC 8 requires the suite to pass under both
// UTC and Asia/Jakarta, so the timezone comes from the environment (CI matrix).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
