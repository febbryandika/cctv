export const AUTH_FILE = 'e2e/.auth/operator.json'
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

// The seeded operator (docs/ARCHITECTURE.md#the-api-surface). Here rather than
// in each spec so auth.setup.ts and e2e/journey.spec.ts cannot drift apart on
// the default - journey.spec.ts types these into the real form, and it is the
// only thing in the suite that exercises the form at all.
//
// These defaults are exactly what .env.example ships, so a clean clone needs no
// environment at all. They are read from the Playwright process, which does not
// load any .env file; export them if the local seed used something else.
export const SEED_EMAIL = process.env.SEED_OPERATOR_EMAIL ?? 'operator@ronda.local'
export const SEED_PASSWORD = process.env.SEED_OPERATOR_PASSWORD ?? 'ronda-operator'
