import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BRIDGE_BOT = '00000000-0000-0000-0000-0000000000b0'
const PLAIN_BOT = '00000000-0000-0000-0000-0000000000b1'
const BRIDGE_ID = '00000000-0000-0000-0000-0000000000f0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const GENERAL = '00000000-0000-0000-0000-0000000000c1'

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  config: { bridge: { configPollMs: 5_000, instanceDomain: 'harmony.test', publicUrl: '' } },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  config: mocks.config,
}))

import { BridgeConfigWatcher } from '../BridgeConfigWatcher.js'
import type { WebSocketGateway } from '../WebSocketGateway.js'

let db: FakeDb
let sessions: Array<{ botId: string; sessionId: string }>
let sent: Array<{ botId: string; event: any }>

function makeGateway(): WebSocketGateway {
  return {
    getConnectedBots: () => sessions.map((s) => ({ ...s, username: 'x', scopes: [], lastHeartbeat: 0, tokenHash: 'h' })),
    sendToBot: (botId: string, event: any) => sent.push({ botId, event }),
  } as unknown as WebSocketGateway
}

beforeEach(() => {
  db = new FakeDb({
    discord_bridges: [{
      id: BRIDGE_ID, server_id: SERVER_ID, bot_id: BRIDGE_BOT, mode: 'self', discord_guild_id: '100000000000000001',
      settings: { sync_edits: true }, updated_at: '2026-10-07T10:00:00.000Z',
    }],
    discord_bridge_channels: [
      { id: 'p1', bridge_id: BRIDGE_ID, harmony_channel_id: GENERAL, discord_channel_id: '200000000000000001', discord_channel_name: 'general', direction: 'both' },
    ],
    channels: [{ id: GENERAL, server_id: SERVER_ID, name: 'general', type: 0, category: null, order: 0 }],
    channel_categories: [],
    bot_server_permissions: [{ id: 'i1', bot_id: BRIDGE_BOT, server_id: SERVER_ID, is_active: true, read_messages: true }],
    server_roles: [{ id: 'e0', server_id: SERVER_ID, permissions: 122646786, is_default: true }],
    channel_permission_overrides: [],
  })
  mocks.from.mockReset()
  mocks.from.mockImplementation((table: string) => db.from(table))
  mocks.rpc.mockReset()
  mocks.rpc.mockResolvedValue({ data: [GENERAL], error: null })
  mocks.config.bridge.instanceDomain = 'harmony.test'
  sessions = [
    { botId: BRIDGE_BOT, sessionId: 's1' },
    { botId: PLAIN_BOT, sessionId: 's2' },
  ]
  sent = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BridgeConfigWatcher', () => {
  it('sends the current configuration on a session\'s first poll, to the bridge bot only', async () => {
    const watcher = new BridgeConfigWatcher(makeGateway(), 1_000)
    await watcher.poll()

    expect(sent).toHaveLength(1)
    expect(sent[0].botId).toBe(BRIDGE_BOT)
    expect(sent[0].event).toMatchObject({
      op: 0,
      t: 'BRIDGE_CONFIG_UPDATE',
      d: {
        bridge_id: BRIDGE_ID,
        server_id: SERVER_ID,
        discord_guild_id: '100000000000000001',
        settings: { sync_edits: true },
        updated_at: '2026-10-07T10:00:00.000Z',
        base_url: 'https://harmony.test',
        pairs: [{ harmony_channel_id: GENERAL, harmony_channel_name: 'general', discord_channel_id: '200000000000000001', direction: 'both' }],
        harmony_channels: [{ id: GENERAL, name: 'general', encrypted: true }],
      },
    })
    expect(mocks.rpc).toHaveBeenCalledWith('discord_bridge_encrypted_channel_ids', { p_bridge_id: BRIDGE_ID })
  })

  it('sends a null base_url when no instance URL is configured', async () => {
    mocks.config.bridge.instanceDomain = ''
    const watcher = new BridgeConfigWatcher(makeGateway(), 1_000)
    await watcher.poll()

    expect(sent[0].event.d.base_url).toBeNull()
  })

  it('sends nothing while updated_at is unchanged', async () => {
    const watcher = new BridgeConfigWatcher(makeGateway(), 1_000)
    await watcher.poll()
    await watcher.poll()

    expect(sent).toHaveLength(1)
  })

  it('sends again when updated_at moves', async () => {
    const watcher = new BridgeConfigWatcher(makeGateway(), 1_000)
    await watcher.poll()
    Object.assign(db.rows('discord_bridges')[0], { updated_at: '2026-10-07T10:05:00.000Z', settings: { sync_edits: false } })
    db.rows('discord_bridge_channels').splice(0)
    await watcher.poll()

    expect(sent).toHaveLength(2)
    expect(sent[1].event.d).toMatchObject({ settings: { sync_edits: false }, pairs: [] })
  })

  it('sends to a reconnected session of the same bot', async () => {
    const watcher = new BridgeConfigWatcher(makeGateway(), 1_000)
    await watcher.poll()
    sessions = [{ botId: BRIDGE_BOT, sessionId: 's3' }]
    await watcher.poll()

    expect(sent).toHaveLength(2)
  })

  it('sends nothing when no bridge bot is connected', async () => {
    sessions = [{ botId: PLAIN_BOT, sessionId: 's2' }]
    const watcher = new BridgeConfigWatcher(makeGateway(), 1_000)
    await watcher.poll()

    expect(sent).toHaveLength(0)
  })

  it('retries after a failed lookup', async () => {
    db.failures.discord_bridges = { message: 'connection reset' }
    const watcher = new BridgeConfigWatcher(makeGateway(), 1_000)
    await watcher.poll()
    expect(sent).toHaveLength(0)

    delete db.failures.discord_bridges
    await watcher.poll()
    expect(sent).toHaveLength(1)
  })

  it('retries after a failed configuration build', async () => {
    db.failures.channels = { message: 'connection reset' }
    const watcher = new BridgeConfigWatcher(makeGateway(), 1_000)
    await watcher.poll()
    expect(sent).toHaveLength(0)

    delete db.failures.channels
    await watcher.poll()
    expect(sent).toHaveLength(1)
  })

  it('polls on its interval', async () => {
    vi.useFakeTimers()
    try {
      const watcher = new BridgeConfigWatcher(makeGateway(), 1_000)
      watcher.start()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sent).toHaveLength(1)
      watcher.stop()
      Object.assign(db.rows('discord_bridges')[0], { updated_at: '2026-10-07T10:05:00.000Z' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(sent).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
