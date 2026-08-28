// Creates the single operator account and the one camera row
// (docs/ARCHITECTURE.md#the-trust-boundary, #data).
//
//   cd apps/api && bun run db:seed
//
// Idempotent: re-running against a seeded database changes nothing.

import { createLocalAccountIssuer } from '@better-auth/core/db'
import { auth } from '../auth'
import { cameraUrls, maskRtsp } from '../camera'
import { db, sql } from './index'
import { cameras } from './schema'

const email = Bun.env.SEED_OPERATOR_EMAIL ?? 'operator@ronda.local'
const password = Bun.env.SEED_OPERATOR_PASSWORD ?? 'ronda-operator'

// Same guard as scripts/render-mediamtx.ts, for the same reason: an empty
// source stores a URL that looks right and never connects.
const { main, sub, missing } = cameraUrls()

if (missing.length > 0) {
  console.error(
    `seed: missing or empty in .env — ${missing.join(', ')}\n` +
      'Run `cp .env.example .env` at the repo root and fill them in.',
  )
  process.exit(1)
}

// The same two URLs the recorder is configured with, read from the same two
// variables, so the database row and mediamtx.yml cannot disagree about where
// the camera is (docs/ARCHITECTURE.md#the-media-pipeline).

// Sign-up is disabled, so auth.api.signUpEmail would refuse. This is the exact
// path Better Auth's own sign-up route takes once it is past that check —
// including the synthetic `issuer`, which is NOT NULL and which linkAccount
// does not fill in for you.
//
// The credential account is checked separately from the user: the password
// lives on the account row, so a run that created the user and then failed
// would otherwise look "already seeded" forever and never be repairable.
const ctx = await auth.$context
const found = await ctx.internalAdapter.findUserByEmail(email)

const linkCredential = async (userId: string) =>
  ctx.internalAdapter.linkAccount({
    userId,
    providerId: 'credential',
    issuer: createLocalAccountIssuer('credential'),
    accountId: userId,
    password: await ctx.password.hash(password),
  })

if (!found) {
  const user = await ctx.internalAdapter.createUser(
    { email, name: 'Operator', emailVerified: true },
    { method: 'email-password' },
  )
  await linkCredential(user.id)
  console.log('seed: operator account created')
} else if (!(await ctx.internalAdapter.findCredentialAccount(found.user.id))) {
  await linkCredential(found.user.id)
  console.log('seed: operator password set — the account row was missing')
} else {
  console.log(`seed: operator account already exists — ${email}`)
}

// Upsert, not insert-or-skip. .env is the source of truth for where the camera
// is, and it changes: a camera gets a new address, or a whole URL shape turns
// out to be wrong. onConflictDoNothing would leave the row pointing at the old
// URL forever while mediamtx.yml pointed at the new one — and seed would print
// the new URLs while having stored neither, which is the specific kind of quiet
// disagreement this project exists to avoid.
//
// `name` is deliberately NOT updated: it is the operator's label for the
// camera, not configuration, and re-seeding should not rename it back.
const [camera] = await db
  .insert(cameras)
  .values({
    slug: 'yard',
    name: 'Yard',
    rtspMain: main, // recorded continuously
    rtspSub: sub, // live view only
  })
  .onConflictDoUpdate({
    target: cameras.slug,
    set: { rtspMain: main, rtspSub: sub },
  })
  .returning({ id: cameras.id, createdAt: cameras.createdAt })

const fresh = camera !== undefined && Date.now() - camera.createdAt.getTime() < 5_000
console.log(fresh ? "seed: camera 'yard' created" : "seed: camera 'yard' stream URLs updated")

await sql.end()

// Masked, like doctor and render:mediamtx (docs/ARCHITECTURE.md#measurement,
// #the-trust-boundary): a stream URL carries the camera's credentials, so
// printing one in full leaks them.
console.log('')
console.log('  operator  ' + email)
console.log('  password  ' + password)
console.log('')
console.log(`  yard      ${maskRtsp(main)}`)
console.log(`  yard_sub  ${maskRtsp(sub)}`)
