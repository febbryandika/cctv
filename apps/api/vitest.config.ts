import { defineConfig } from 'vitest/config'

// TZ is deliberately NOT set here. The timeline rules
// (docs/ARCHITECTURE.md#timeline-gaps-and-coverage) require the suite to pass
// under both UTC and Asia/Jakarta, so the timezone comes from the environment
// (CI matrix).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
