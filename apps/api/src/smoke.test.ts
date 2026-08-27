import { describe, expect, it } from 'vitest'
import app from './index'

describe('api smoke', () => {
  it('serves a health payload at the root', async () => {
    const res = await app.fetch(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  // The only assertion that /cameras is mounted on the REAL app rather than on
  // a test-local Hono, and it mocks nothing. Better Auth resolves a cookieless
  // request to null without touching the database, so this needs no
  // environment. If that ever regresses, weaken it to .not.toBe(404).
  it('guards /cameras', async () => {
    const res = await app.fetch(new Request('http://localhost/cameras'))

    expect(res.status).toBe(401)
  })

  // Likewise for the WHEP proxy: mounted on the real app, and closed. The
  // session guard runs before anything reaches MediaMTX, so this makes no
  // network call even though it names a real path
  // (docs/ARCHITECTURE.md#the-trust-boundary).
  it('guards the WHEP proxy', async () => {
    const res = await app.fetch(
      new Request('http://localhost/live/yard/whep', {
        method: 'POST',
        headers: { 'content-type': 'application/sdp' },
        body: 'v=0\r\n',
      }),
    )

    expect(res.status).toBe(401)
  })
})
