import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import type { Server } from 'http'
import { createHash } from 'crypto'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const BRIDGE_ID = '00000000-0000-0000-0000-0000000000f0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const TOKEN = 'harmony_bot_bridge'
const TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex')

// RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX_REQUESTS defaults (config/supabase.ts).
const WINDOW_MS = 60_000
const MAX_REQUESTS = 100

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  config: {
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
    bridge: { instanceDomain: 'harmony.test', publicUrl: '', hostSecret: '', configPollMs: 5_000 },
  },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: mocks.config,
}))

import { BridgeV2API } from '../BridgeV2API.js'

/**
 * check_and_increment_bot_rate_limit: a fixed window per (bot, bucket), opened by its first
 * request and closed at both ends (a request at resets_at still counts in it).
 */
class RateLimitTable {
  now = 0
  private windows = new Map<string, { count: number; resetsAt: number }>()
  readonly peak = new Map<string, number>()

  check(botId: string, bucket: string, limit: number, windowSeconds: number): boolean {
    const key = `${botId} ${bucket}`
    let w = this.windows.get(key)
    if (!w || w.resetsAt < this.now) {
      w = { count: 0, resetsAt: this.now + windowSeconds * 1000 }
      this.windows.set(key, w)
    }
    w.count += 1
    this.peak.set(bucket, Math.max(this.peak.get(bucket) ?? 0, w.count))
    return w.count > limit
  }
}

let table: RateLimitTable
let server: Server

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/bridge/v2', new BridgeV2API().router)
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  mocks.config.rateLimit = { windowMs: WINDOW_MS, maxRequests: MAX_REQUESTS }
  table = new RateLimitTable()
  const db = new FakeDb({
    discord_bridges: [{
      id: BRIDGE_ID, server_id: SERVER_ID, bot_id: BOT_ID, mode: 'self', discord_guild_id: '100000000000000001',
      settings: {}, updated_at: '2026-10-07T10:00:00.000Z',
    }],
    discord_bridge_channels: [],
    channels: [],
    channel_categories: [],
    bot_server_permissions: [],
  })
  mocks.from.mockReset()
  mocks.from.mockImplementation((t: string) => db.from(t))
  mocks.rpc.mockReset()
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    switch (fn) {
      case 'verify_bot_token':
        return args.p_token_hash === TOKEN_SHA256
          ? { data: { valid: true, bot_id: BOT_ID, username: 'bridge', scopes: ['bot'] }, error: null }
          : { data: { valid: false }, error: null }
      case 'check_and_increment_bot_rate_limit':
        return { data: table.check(args.p_bot_id, args.p_bucket, args.p_limit, args.p_window_seconds), error: null }
      case 'discord_bridge_encrypted_channel_ids':
        return { data: [], error: null }
      case 'discord_bridge_report_status':
        return { data: { bridge_id: BRIDGE_ID, discord_guild_id: '100000000000000001' }, error: null }
      case 'discord_bridge_bot_unpair':
        return { data: true, error: null }
      default:
        throw new Error(`test called unmocked rpc: ${fn}`)
    }
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

type Call = { at: number; method: 'get' | 'post' | 'delete'; path: string; body?: unknown }

function every(periodMs: number, untilMs: number, call: Omit<Call, 'at'>, offsetMs = 0): Call[] {
  const calls: Call[] = []
  for (let at = offsetMs; at < untilMs; at += periodMs) calls.push({ at, ...call })
  return calls
}

/** Replays the calls in time order; returns the statuses seen. */
async function replay(calls: Call[]): Promise<number[]> {
  const statuses: number[] = []
  const agent = supertest(server)
  for (const call of [...calls].sort((a, b) => a.at - b.at)) {
    table.now = call.at
    const req = agent[call.method](call.path).set('Authorization', `Bot ${TOKEN}`)
    const res = call.body === undefined ? await req : await req.send(call.body as object)
    statuses.push(res.status)
  }
  return statuses
}

const STATUS = { method: 'post' as const, path: '/bridge/v2/status', body: { version: '2.0.0', discord: { connected: true }, guilds: [] } }
const CONFIG = { method: 'get' as const, path: '/bridge/v2/config' }

describe('bridge traffic against the per-bot, per-route rate limit', () => {
  const TEN_MINUTES = 10 * 60_000

  // A window spans 60 s inclusive, so it can hold three 30 s heartbeats and two 60 s refreshes.
  it('a steady bridge uses three status and two config requests per window at most', async () => {
    const statuses = await replay([
      ...every(30_000, TEN_MINUTES, STATUS),
      ...every(60_000, TEN_MINUTES, CONFIG, 500),
    ])

    expect(statuses.every((s) => s === 200)).toBe(true)
    expect(Object.fromEntries(table.peak)).toEqual({ '/bridge/v2/status': 3, '/bridge/v2/config': 2 })
  })

  // Bridge program v2: a status on every change, debounced to one per 2 s, beside the 30 s
  // heartbeat; a config fetch on every BRIDGE_CONFIG_UPDATE, at most one per 5 s watcher poll,
  // beside the 60 s refresh; a burst of 20 /bridge link and 20 unlink commands.
  it('a bridge at its busiest stays under half the default limit on every route', async () => {
    const links = Array.from({ length: 20 }, (_, i) => ({
      at: 10_000 + i * 1_000,
      method: 'post' as const,
      path: '/bridge/v2/pairs',
      body: { discord_channel_id: `2000000000000000${String(i).padStart(2, '0')}`, harmony_channel_id: 'x' },
    }))
    const unlinks = Array.from({ length: 20 }, (_, i) => ({
      at: 10_500 + i * 1_000,
      method: 'delete' as const,
      path: `/bridge/v2/pairs/2000000000000000${String(i).padStart(2, '0')}`,
    }))
    const statuses = await replay([
      ...every(2_000, TEN_MINUTES, STATUS),
      ...every(30_000, TEN_MINUTES, STATUS, 1_000),
      ...every(5_000, TEN_MINUTES, CONFIG, 250),
      ...every(60_000, TEN_MINUTES, CONFIG, 750),
      ...links,
      ...unlinks,
    ])

    expect(statuses).not.toContain(429)
    expect(Object.fromEntries(table.peak)).toEqual({
      '/bridge/v2/status': 33,
      '/bridge/v2/config': 14,
      '/bridge/v2/pairs': 20,
      '/bridge/v2/pairs/:discordChannelId': 20,
    })
    for (const peak of table.peak.values()) expect(peak).toBeLessThan(MAX_REQUESTS / 2)
  })

  it('answers 429 once a route exceeds the limit, without affecting the other routes', async () => {
    mocks.config.rateLimit = { windowMs: WINDOW_MS, maxRequests: 3 }
    const statuses = await replay([
      ...every(1_000, 5_000, STATUS),
      { at: 5_500, ...CONFIG },
    ])

    expect(statuses).toEqual([200, 200, 200, 429, 429, 200])
  })
})
