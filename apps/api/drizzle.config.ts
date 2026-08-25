import { defineConfig } from 'drizzle-kit'

// Migrations use the DIRECT (unpooled) connection string: PgBouncer in
// transaction mode does not support the session-level statements drizzle-kit
// issues. See SPEC 5.2.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT ?? '',
  },
})
