import { app } from './index'
import { startPoller } from './mediamtx/poller'
import { startSnapshot } from './timeline/snapshot'

// The entrypoint, and the only module that starts anything.
//
// Long-lived jobs are plain module-level code here, which is half the reason
// this API is its own process (docs/ARCHITECTURE.md#why-a-separate-api-server):
// in Next each of these would be a lifecycle hook plus a globalThis guard to
// survive HMR. Under `bun --watch` an edit restarts the whole process and both
// jobs re-read their state from Postgres, so they come back consistent.
//
// They live HERE rather than in ./index so that importing the app - which the
// test suite does, and which apps/web typechecks - starts no timers and opens
// no sockets. That used to be a `process.env.VITEST` check inside startPoller;
// a test-runner branch in production code is a real cost, and this file is
// cheaper than that branch.
startPoller()
startSnapshot()

export default {
  port: Number(process.env.PORT ?? 3001),
  fetch: app.fetch,

  // Seconds, and load-bearing for /health/events. Bun.serve defaults to 10s and
  // closes any connection that has moved no data since - which for a Server-Sent
  // Events stream is every quiet connection there is. Left at the default, the
  // health page's stream dies ten seconds after it opens, the poller goes on
  // writing transitions nobody receives, and the only symptom is one
  // `[Bun.serve]: request timed out` line in a log nobody is watching. The
  // keepalive in routes/health.ts fires well inside this, and a write resets the
  // clock, so a live stream never reaches it. Bun caps this at 255.
  idleTimeout: 60,
}
