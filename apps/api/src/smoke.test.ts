import { describe, expect, it } from 'vitest'
import app from './index'

describe('api smoke', () => {
  it('serves a health payload at the root', async () => {
    const res = await app.fetch(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
