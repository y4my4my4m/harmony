import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const CHANNEL_A = '00000000-0000-0000-0000-0000000000c1'
const CHANNEL_B = '00000000-0000-0000-0000-0000000000c2'
const MESSAGE_ID = '00000000-0000-0000-0000-0000000000d1'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  config: {
    supabaseUrl: 'http://localhost:54321',
    port: 3002,
    nodeEnv: 'test',
    instanceDomain: 'harmony.test',
    websocket: { heartbeatInterval: 30_000, maxConnectionsPerBot: 5, revalidateIntervalMs: 30_000 },
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: mocks.config,
}))

import { BotRestAPI } from '../../api/BotRestAPI.js'

let buckets: string[]
let limited: boolean

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', new BotRestAPI().router)
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })
  return app
}

function get(path: string) {
  return supertest(makeApp()).get(path).set('Authorization', 'Bot hrm_bot_9f2c1d4e8a7b')
}

beforeEach(() => {
  buckets = []
  limited = true
  mocks.rpc.mockReset()
  mocks.from.mockReset()
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    if (fn === 'verify_bot_token') {
      return { data: { valid: true, bot_id: BOT_ID, username: 'testbot', scopes: ['bot'] }, error: null }
    }
    if (fn === 'check_and_increment_bot_rate_limit') {
      buckets.push(args.p_bucket)
      return { data: limited, error: null }
    }
    throw new Error(`test called unmocked rpc: ${fn}`)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rate-limit buckets', () => {
  // A bucket per spelling multiplies a bot's limit by the spellings it can mint.
  it('keys every spelling of a route on one channel to one bucket', async () => {
    const paths = [
      `/api/v1/channels/${CHANNEL_A}/messages`,
      `/api/v1/channels/${CHANNEL_A}/messages/`,
      `/api/v1//channels/${CHANNEL_A}/messages`,
      `/api/v1/Channels/${CHANNEL_A}/MESSAGES`,
      `/API/V1/channels/${CHANNEL_A.toUpperCase()}/messages`,
      `/api/v1/channels/${CHANNEL_A}/messages?limit=5&nonce=${Math.random()}`,
    ]
    for (const path of paths) {
      expect((await get(path)).status).toBe(429)
    }

    expect(new Set(buckets)).toEqual(new Set([`/api/v1/channels/${CHANNEL_A}/messages`]))
    expect(buckets).toHaveLength(paths.length)
  })

  it('keeps a bucket per channel, and one shared bucket for malformed channel ids', async () => {
    await get(`/api/v1/channels/${CHANNEL_B}/messages`)
    await get('/api/v1/channels/not-a-uuid/messages')
    await get(`/api/v1/channels/x${Math.random()}/messages`)

    expect(buckets).toEqual([
      `/api/v1/channels/${CHANNEL_B}/messages`,
      '/api/v1/channels/:invalid/messages',
      '/api/v1/channels/:invalid/messages',
    ])
  })

  it('keys free-form segments (invite codes, emoji) to the route pattern', async () => {
    await get('/api/v1/invites/abc123/preview')
    await get('/api/v1/invites/zzz999/preview')
    const app = makeApp()
    await supertest(app)
      .put(`/api/v1/messages/${MESSAGE_ID}/reactions/${encodeURIComponent('👍')}`)
      .set('Authorization', 'Bot hrm_bot_9f2c1d4e8a7b')
    await supertest(app)
      .put(`/api/v1/messages/${MESSAGE_ID}/reactions/blobcat`)
      .set('Authorization', 'Bot hrm_bot_9f2c1d4e8a7b')

    expect(buckets).toEqual([
      '/api/v1/invites/:code/preview',
      '/api/v1/invites/:code/preview',
      '/api/v1/messages/:messageId/reactions/:emoji',
      '/api/v1/messages/:messageId/reactions/:emoji',
    ])
  })

  it('counts requests no route matches in one shared bucket', async () => {
    limited = false
    const unmatched = [
      `/api/v1/channels//${CHANNEL_A}/messages`,
      `/api/v1/no/such/route/${Math.random()}`,
      `/api/v1/no/such/route/${Math.random()}`,
    ]
    for (const path of unmatched) {
      expect((await get(path)).status).toBe(404)
    }
    expect(buckets).toEqual(['unmatched', 'unmatched', 'unmatched'])

    limited = true
    expect((await get(`/api/v1/no/such/route/${Math.random()}`)).status).toBe(429)
  })

  it('counts nothing for a request refused at authentication', async () => {
    const res = await supertest(makeApp()).get(`/api/v1/channels/${CHANNEL_A}/messages`)

    expect(res.status).toBe(401)
    expect(buckets).toEqual([])
  })
})
