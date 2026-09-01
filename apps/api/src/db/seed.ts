// Creates the single operator account and one row per configured camera
// (docs/ARCHITECTURE.md#the-trust-boundary, #data).
//
//   cd apps/api && bun run db:seed
//
// Idempotent: re-running against a seeded database changes nothing.

import { createLocalAccountIssuer } from '@better-auth/core/db'
import { auth } from '../auth'
import { cameraConfigs, maskRtsp } from '../camera'
import { db, sql } from './index'
import { cameras } from './schema'

const email = Bun.env.SEED_OPERATOR_EMAIL ?? 'operator@ronda.local'
const password = Bun.env.SEED_OPERATOR_PASSWORD ?? 'ronda-operator'

// Same guard as scripts/render-mediamtx.ts, for the same reason: an empty
// source stores a URL that looks right and never connects.
const { cameras: configured, missing, errors } = cameraConfigs()

if (errors.length > 0) {
  console.error(`seed: ${errors.join('\n      ')}`)
  process.exit(1)
}

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
for (const camera of configured) {
  const [row] = await db
    .insert(cameras)
    .values({
      slug: camera.slug,
      name: camera.name,
      rtspMain: camera.main, // recorded continuously
      rtspSub: camera.sub, // live view only
    })
    .onConflictDoUpdate({
      target: cameras.slug,
      set: { rtspMain: camera.main, rtspSub: camera.sub },
    })
    .returning({ id: cameras.id, createdAt: cameras.createdAt })

  const fresh = row !== undefined && Date.now() - row.createdAt.getTime() < 5_000
  console.log(
    fresh
      ? `seed: camera '${camera.slug}' created`
      : `seed: camera '${camera.slug}' stream URLs updated`,
  )
}

// Reported, never deleted. stream_events and daily_coverage both reference
// cameras.slug ON DELETE CASCADE, so pruning a camera that dropped out of
// CAMERAS would take its whole reliability record with it - the record the
// nightly snapshot exists to keep after the footage itself has aged out. A
// camera commented out for an afternoon must not cost a year of history.
const orphans = (await db.select({ slug: cameras.slug }).from(cameras)).filter(
  (row) => !configured.some((camera) => camera.slug === row.slug),
)

for (const orphan of orphans) {
  console.log(
    `seed: '${orphan.slug}' is in the database but not in CAMERAS - left alone, because ` +
      'deleting it would cascade away its stream_events and daily_coverage rows. ' +
      'Set enabled = false by hand to hide it from the UI.',
  )
}

await sql.end()

// Masked, like doctor and render:mediamtx (docs/ARCHITECTURE.md#measurement,
// #the-trust-boundary): a stream URL carries the camera's credentials, so
// printing one in full leaks them.
console.log('')
console.log('  operator  ' + email)
console.log('  password  ' + password)
console.log('')
const width = Math.max(...configured.map((camera) => camera.slug.length)) + 6
for (const camera of configured) {
  console.log(`  ${camera.slug.padEnd(width)}${maskRtsp(camera.main)}`)
  console.log(`  ${`${camera.slug}_sub`.padEnd(width)}${maskRtsp(camera.sub)}`)
}
