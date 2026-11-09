import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const CHANNEL_ID = '00000000-0000-0000-0000-0000000000c1'
const ROLE_ID = '00000000-0000-0000-0000-0000000000e0'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: {},
}))
vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = { id: BOT_ID, username: 'reader', scopes: ['bot'] }
    next()
  },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))

import { BotRestAPI } from '../BotRestAPI.js'

let db: FakeDb
function request() {
  const app = express()
  app.use('/api/v1', new BotRestAPI().router)
  return supertest(app).get(`/api/v1/channels/${CHANNEL_ID}/encryption`)
}

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.from.mockReset()
  db = new FakeDb({
    channels: [{ id: CHANNEL_ID, server_id: SERVER_ID }],
    server_roles: [{ id: ROLE_ID, server_id: SERVER_ID, is_default: true, permissions: 122646786 }],
    bot_server_permissions: [{
      id: 'install', bot_id: BOT_ID, server_id: SERVER_ID, is_active: true, read_messages: true,
    }],
  })
  mocks.from.mockImplementation((table: string) => db.from(table))
  mocks.rpc.mockResolvedValue({ data: false, error: null })
})

describe('GET /channels/:channelId/encryption', () => {
  it('denies a bot without read_messages before querying encryption', async () => {
    db.rows('bot_server_permissions')[0].read_messages = false
    const res = await request()
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'Missing permission: read_messages' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('denies a hidden channel before querying encryption', async () => {
    db.rows('channel_permission_overrides').push({
      channel_id: CHANNEL_ID, target_type: 'role', role_id: ROLE_ID,
      allow_permissions: 0, deny_permissions: 2,
    })
    expect((await request()).status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('denies an inactive installation before querying encryption', async () => {
    db.rows('bot_server_permissions')[0].is_active = false
    expect((await request()).status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it.each([true, false])('returns the authoritative encryption boolean %s', async (encrypted) => {
    mocks.rpc.mockResolvedValue({ data: encrypted, error: null })
    const res = await request()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ messages_encrypted: encrypted })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.rpc).toHaveBeenCalledWith('channel_messages_encrypted', {
      p_channel_id: CHANNEL_ID,
    })
  })

  it.each([
    { data: false, error: { message: 'database unavailable' } },
    { data: null, error: null },
    { data: 'false', error: null },
    { data: 0, error: null },
    { data: {}, error: null },
  ])('fails closed for an unavailable or nonboolean RPC result: %j', async (result) => {
    mocks.rpc.mockResolvedValue(result)
    const res = await request()
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'Channel encryption status unavailable' })
    expect(res.body).not.toHaveProperty('messages_encrypted')
  })

  it('fails closed if the encryption RPC rejects', async () => {
    mocks.rpc.mockRejectedValue(new Error('connection failed'))
    const res = await request()
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'Channel encryption status unavailable' })
  })
})
