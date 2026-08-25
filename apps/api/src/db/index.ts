import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

// Pooled connection string — the host contains `-pooler` (PgBouncer) on Neon.
// Migrations use DATABASE_URL_DIRECT instead; see drizzle.config.ts (SPEC 5.2).
//
// idle_timeout matters far more than it looks. Neon's Free plan scales a
// compute to zero after 5 minutes of inactivity and does not let you turn
// that off, but a pool holding an idle socket open counts as activity. Left
// at the driver default, this app keeps the compute awake ~730 h/month
// against a 100 CU-hour budget and gets suspended partway through the month.
// Closing idle sockets lets Neon sleep, which is the whole point of Neon.
// It is not a tuning knob — do not remove it because a query felt slow.
const sql = postgres(process.env.DATABASE_URL!, {
  max: 5,
  idle_timeout: 30, // seconds
  max_lifetime: 60 * 30,
  prepare: false, // PgBouncer runs in transaction mode
})

export const db = drizzle(sql, { schema })

// Exported for short-lived scripts (db:seed) only: without an explicit end()
// the process lingers until idle_timeout expires. Long-lived callers — the
// Hono server — must never call this.
export { sql }
