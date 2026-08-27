import { defineConfig } from 'drizzle-kit'

// drizzle-kit is not run through Bun's runtime, so it does not pick up the
// `--env-file=../../.env` the other scripts use — and .env lives at the repo
// root, two levels above the cwd drizzle-kit runs in. Without this, the config
// below resolves to url: '' and `bun run db:migrate` fails with
// "Please provide required params for Postgres driver".
//
// Loading it here rather than in the package.json script means every
// invocation works, including a bare `bunx drizzle-kit generate|migrate|studio`.
process.loadEnvFile(new URL('../../.env', import.meta.url).pathname)

// Migrations use the DIRECT (unpooled) connection string: PgBouncer in
// transaction mode does not support the session-level statements drizzle-kit
// issues. See docs/ARCHITECTURE.md#data. Both URLs must point at the SAME
// database — a pooled URL on Neon and a direct URL on localhost silently
// migrates one database while the app reads another.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT ?? '',
  },
})
