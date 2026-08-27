// Creates the single operator account and the one camera row
// (docs/ARCHITECTURE.md#the-trust-boundary, #data).
//
//   cd apps/api && bun run db:seed
//
// Idempotent: re-running against a seeded database changes nothing.

import { createLocalAccountIssuer } from '@better-auth/core/db'
import { auth } from '../auth'
import { db, sql } from './index'
import { cameras } from './schema'

const email = Bun.env.SEED_OPERATOR_EMAIL ?? 'operator@ronda.local'
const password = Bun.env.SEED_OPERATOR_PASSWORD ?? 'ronda-operator'

// Same guard as scripts/render-mediamtx.ts, for the same reason: md5('') is
// d41d8cd98f00b204e9800998ecf8427e — a real-looking hash for a missing
// password, which would store a URL that looks right and never connects.
const cameraIp = Bun.env.CAMERA_IP ?? ''
const onvifPassword = Bun.env.ONVIF_PASSWORD ?? ''

const missing = (
  [
    ['CAMERA_IP', cameraIp],
    ['ONVIF_PASSWORD', onvifPassword],
  ] as const
)
  .filter(([, value]) => value === '')
  .map(([name]) => name)

if (missing.length > 0) {
  console.error(
    `seed: missing or empty in .env — ${missing.join(', ')}\n` +
      'Run `cp .env.example .env` at the repo root and fill them in.',
  )
  process.exit(1)
}

// The BARDI-family path is rtsp://<ip>:5543/<md5(onvif_password)>/live/channelN
// (docs/ARCHITECTURE.md#the-media-pipeline). mediamtx.template.yml is the
// source of truth for that shape; this builds the same URL so the row and the
// recorder agree.
const hash = new Bun.CryptoHasher('md5').update(onvifPassword).digest('hex')
const rtsp = (channel: 0 | 1) => `rtsp://${cameraIp}:5543/${hash}/live/channel${channel}`

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

const [camera] = await db
  .insert(cameras)
  .values({
    slug: 'yard',
    name: 'Yard',
    rtspMain: rtsp(0), // recorded continuously
    rtspSub: rtsp(1), // live view only
  })
  .onConflictDoNothing({ target: cameras.slug })
  .returning()

console.log(camera ? "seed: camera 'yard' created" : "seed: camera 'yard' already exists")

await sql.end()

// Masked, like doctor and render:mediamtx (docs/ARCHITECTURE.md#measurement,
// #the-trust-boundary): the path IS the password's MD5, so printing it leaks a
// password hash.
console.log('')
console.log('  operator  ' + email)
console.log('  password  ' + password)
console.log('')
console.log(`  yard      rtsp://${cameraIp}:5543/${'•'.repeat(8)}/live/channel0`)
console.log(`  yard_sub  rtsp://${cameraIp}:5543/${'•'.repeat(8)}/live/channel1`)
