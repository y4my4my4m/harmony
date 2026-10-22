import { describe, it, expect, vi, afterAll } from 'vitest'
import supertest from 'supertest'

// Signed-in routes of the gateway's HTTP app: /status and /bridged-users.
//   member    views general, not staff
//   stranger  in no server
//   admin     instance admin

const BRIDGE_BOT = '00000000-0000-0000-0000-0000000000b0'
const PRIVATE_BOT = '00000000-0000-0000-0000-0000000000b9'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const MEMBER_ID = '00000000-0000-0000-0000-0000000000a3'
const STRANGER_ID = '00000000-0000-0000-0000-0000000000a9'
const ADMIN_ID = '00000000-0000-0000-0000-0000000000aa'
const OWNER_OF_PRIVATE = '00000000-0000-0000-0000-0000000000ab'
const GENERAL = '00000000-0000-0000-0000-0000000000c1'
const STAFF = '00000000-0000-0000-0000-0000000000c2'

const state = vi.hoisted(() => ({ db: null as any }))

vi.mock('../config/supabase.js', () => ({
  supabase: {
    from: (t: string) => state.db.from(t),
    rpc: async (name: string, args: any) => {
      if (name === 'has_permission') {
        const views = args.p_user_id === MEMBER_ID && args.p_server_id === SERVER_ID && args.p_channel_id === GENERAL
        return { data: views, error: null }
      }
      if (name === 'channel_message_changes') return { data: { now: new Date().toISOString(), messages: [] }, error: null }
      return { data: null, error: null }
    },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token, factors: [] } }, error: null }) },
    storage: { from: () => ({}) },
  },
  config: {
    port: 0, nodeEnv: 'test', instanceDomain: 'localhost', trustProxy: false,
    bridge: { instanceDomain: '', publicUrl: '', hostSecret: '', configPollMs: 60_000 },
    websocket: { heartbeatInterval: 60_000, maxConnectionsPerBot: 5, identifyTimeoutMs: 60_000, revalidateIntervalMs: 60_000 },
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  },
}))

const { FakeDb } = await import('./fakeSupabase.js')
state.db = new FakeDb({
  servers: [{ id: SERVER_ID, owner: 'someone' }],
  channels: [
    { id: GENERAL, server_id: SERVER_ID, name: 'general' },
    { id: STAFF, server_id: SERVER_ID, name: 'staff' },
  ],
  profiles: [
    { id: MEMBER_ID, auth_user_id: 'auth-member', is_admin: false },
    { id: STRANGER_ID, auth_user_id: 'auth-stranger', is_admin: false },
    { id: ADMIN_ID, auth_user_id: 'auth-admin', is_admin: true },
    { id: OWNER_OF_PRIVATE, auth_user_id: 'auth-bot-owner', is_admin: false },
  ],
  user_servers: [{ user_id: MEMBER_ID, server_id: SERVER_ID, status: 'accepted' }],
  bots: [
    { id: BRIDGE_BOT, owner_id: 'someone', is_public: true },
    { id: PRIVATE_BOT, owner_id: OWNER_OF_PRIVATE, is_public: false },
  ],
  bot_server_permissions: [],
  messages: [], reactions: [], bot_presence: [],
})

const mod = await import('../index.js')
const { app, gateway } = mod

afterAll(async () => {
  try { await mod.eventDispatcher.shutdown() } catch { /* not started */ }
  try { mod.server.close() } catch { /* not listening */ }
})

function connect(botId: string, username: string) {
  ;(gateway as any).connections.set({ readyState: 1, send() {}, close() {} }, {
    botId, username, scopes: [], lastHeartbeat: Date.now(), sessionId: `s-${botId}`, tokenHash: `h-${botId}`,
  })
}

function bridgeMembers(channelId: string, username: string) {
  const byChannel = (gateway as any).bridgedUsersByChannel as Map<string, any[]>
  byChannel.set(channelId, [{ id: username, username, displayName: username, source: 'discord' }])
}

describe('GET /status', () => {
  connect(BRIDGE_BOT, 'public-bridge')
  connect(PRIVATE_BOT, 'secret-moderation-bot')

  const names = async (token: string) =>
    ((await supertest(app).get('/status').set('Authorization', `Bearer ${token}`)).body.bots as Array<{ username: string }>)
      .map((b) => b.username).sort()

  it('lists public bots to a signed-in account, not private ones', async () => {
    expect(await names('auth-stranger')).toEqual(['public-bridge'])
  })

  it('lists a private bot to its owner and to an instance admin', async () => {
    expect(await names('auth-bot-owner')).toEqual(['public-bridge', 'secret-moderation-bot'])
    expect(await names('auth-admin')).toEqual(['public-bridge', 'secret-moderation-bot'])
  })
})

describe('GET /bridged-users', () => {
  it('serves a channel\'s Discord members only to a member who views the channel', async () => {
    bridgeMembers(GENERAL, 'discord_member')
    bridgeMembers(STAFF, 'discord_admin')
    const staff = await supertest(app).get(`/bridged-users/${STAFF}`).set('Authorization', 'Bearer auth-member')
    expect(staff.status).toBe(403)
    const general = await supertest(app).get(`/bridged-users/${GENERAL}`).set('Authorization', 'Bearer auth-member')
    expect(general.status).toBe(200)
  })

  it('leaves channels the caller cannot view out of the server list', async () => {
    const res = await supertest(app).get(`/bridged-users/server/${SERVER_ID}`).set('Authorization', 'Bearer auth-member')
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body.users)).not.toContain('discord_admin')
  })
})
