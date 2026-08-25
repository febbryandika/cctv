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
})
