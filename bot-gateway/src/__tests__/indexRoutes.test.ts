import { describe, it, expect, vi, afterAll, afterEach } from 'vitest'
import supertest from 'supertest'

// Signed-in routes of the gateway's HTTP app: /status, /bridged-users and /attachments/refresh.
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

const state = vi.hoisted(() => ({
  db: null as any,
  instanceToken: null as string | null,
  silentWrites: [] as Array<{ p_message_id: string; p_old_content: unknown; p_content: any[] }>,
  matrixPlatform: 'matrix' as string | null,
  matrixError: false,
}))

vi.mock('../config/supabase.js', () => ({
  supabase: {
    from: (t: string) => state.db.from(t),
    rpc: async (name: string, args: any) => {
      if (name === 'has_permission') {
        const views = args.p_user_id === MEMBER_ID && args.p_server_id === SERVER_ID && args.p_channel_id === GENERAL
        return { data: views, error: null }
      }
      if (name === 'bridge_channel_platform') return { data: state.matrixPlatform, error: state.matrixError ? { message: 'offline' } : null }
      if (name === 'channel_message_changes') return { data: { now: new Date().toISOString(), messages: [] }, error: null }
      if (name === 'discord_bridge_instance_hosted') {
        return { data: state.instanceToken ? { discord_token: state.instanceToken, bridges: [] } : null, error: null }
      }
      if (name === 'update_message_content_silent') {
        state.silentWrites.push(args)
        return { data: true, error: null }
      }
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
  instance_config: [{ config_key: 'bridge_attachment_mode', config_value: 'refresh' }],
})

const mod = await import('../index.js')
const { app, gateway, linkRefresher } = mod
const { forgetBridgeConsent } = await import('../bridge/memberConsent.js')

afterAll(async () => {
  mod.interactionPoller.stop()
  try { await mod.eventDispatcher.shutdown() } catch { /* not started */ }
  try { mod.server.close() } catch { /* not listening */ }
})

function connect(botId: string, username: string) {
  ;(gateway as any).connections.set({ readyState: 1, send() {}, close() {} }, {
    botId, username, scopes: [], lastHeartbeat: Date.now(), sessionId: `s-${botId}`, tokenHash: `h-${botId}`,
  })
}

function bridgeMembers(channelId: string, username: string) {
  const byChannel = (gateway as any).bridgedUsersByChannel as Map<string, Map<string, any[]>>
  byChannel.set(channelId, new Map([[BRIDGE_BOT, [{ id: username, username, displayName: username, source: 'discord' }]]]))
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
  it('lists a Matrix registration only while its bot relays the channel to Matrix', async () => {
    ;(gateway as any).bridgedUsersByChannel.set(GENERAL, new Map([[BRIDGE_BOT, [{ id: '@sam:example.org', username: 'sam', displayName: 'Sam', avatarUrl: '', source: 'matrix' }]]]))
    const route = `/bridged-users/${GENERAL}`
    const get = () => supertest(app).get(route).set('Authorization', 'Bearer auth-member')
    try {
      forgetBridgeConsent()
      expect((await get()).body).toMatchObject({ has_bridge: true, users: [{ id: '@sam:example.org', source: 'matrix' }] })
      state.matrixPlatform = null
      forgetBridgeConsent()
      // has_bridge reports the registration; the unbound registration lists no one.
      expect((await get()).body).toMatchObject({ has_bridge: true, users: [] })
      state.matrixPlatform = 'matrix'
      state.matrixError = true
      forgetBridgeConsent()
      expect((await get()).status).toBe(503)
    } finally {
      state.matrixPlatform = 'matrix'
      state.matrixError = false
      forgetBridgeConsent()
    }
  })

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

  it('leaves out a member who opted out or whom a manager removed, whatever the bridge registered', async () => {
    const KEPT = '400000000000000001'
    const REMOVED = '400000000000000002'
    const byChannel = (gateway as any).bridgedUsersByChannel as Map<string, Map<string, any[]>>
    byChannel.set(GENERAL, new Map([[BRIDGE_BOT, [KEPT, REMOVED].map((id) => ({ id, username: `u${id}`, displayName: `u${id}`, source: 'discord' }))]]))
    state.db.rows('bridge_remote_optouts').push(
      { server_id: SERVER_ID, platform: 'discord', remote_user_id: REMOVED, source: 'manager' },
      { server_id: 'another-server', platform: 'discord', remote_user_id: KEPT, source: 'self' },
    )
    try {
      const channel = await supertest(app).get(`/bridged-users/${GENERAL}`).set('Authorization', 'Bearer auth-member')
      expect(channel.status).toBe(200)
      expect(channel.body.has_bridge).toBe(true)
      expect(channel.body.users.map((u: { id: string }) => u.id)).toEqual([KEPT])
      const server = await supertest(app).get(`/bridged-users/server/${SERVER_ID}`).set('Authorization', 'Bearer auth-member')
      expect(server.status).toBe(200)
      expect(server.body.users.map((u: { id: string }) => u.id)).toEqual([KEPT])
    } finally {
      state.db.tables.bridge_remote_optouts = []
    }
  })

  it('answers 503 when the opt-out list cannot be read', async () => {
    bridgeMembers(GENERAL, 'discord_member')
    state.db.failures.bridge_remote_optouts = { message: 'connection reset' }
    try {
      expect((await supertest(app).get(`/bridged-users/${GENERAL}`).set('Authorization', 'Bearer auth-member')).status).toBe(503)
      expect((await supertest(app).get(`/bridged-users/server/${SERVER_ID}`).set('Authorization', 'Bearer auth-member')).status).toBe(503)
    } finally {
      delete state.db.failures.bridge_remote_optouts
    }
  })
})

describe('POST /attachments/refresh', () => {
  const CLIP = '/attachments/492163058312151061/1569015022057693324/clip.mp4'
  const hex = (ms: number) => Math.floor(ms / 1000).toString(16)
  // Each case moves the clock past the refresher's one-minute token cache.
  let clock = Date.UTC(2026, 10, 13, 15, 0, 0)
  const tick = () => {
    clock += 61_000
    vi.spyOn(Date, 'now').mockReturnValue(clock)
  }
  const expired = () => `https://cdn.discordapp.com${CLIP}?ex=${hex(clock - 3_600_000)}&is=1&hm=2&`
  let seq = 0

  function post(content: unknown[], over: { bot_id?: string; channel_id?: string; metadata?: unknown } = {}) {
    seq += 1
    const id = `00000000-0000-0000-0000-00000000e${String(seq).padStart(3, '0')}`
    state.db.rows('messages').push({
      id, channel_id: over.channel_id ?? GENERAL, author_id: over.bot_id ? null : MEMBER_ID,
      bot_id: over.bot_id ?? null, content, is_deleted: false, metadata: over.metadata ?? {},
    })
    return id
  }
  const refresh = (messageId: string, token = 'auth-member') =>
    supertest(app).post('/attachments/refresh').set('Authorization', `Bearer ${token}`).send({ messageId })

  function discord() {
    const calls: Array<{ url: string; auth: string; urls: string[] }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const urls = JSON.parse(String(init.body)).attachment_urls as string[]
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, urls })
      const refreshed_urls = urls.map((original) => ({ original, refreshed: `${original.split('?')[0]}?ex=${hex(clock + 86_400_000)}&is=3&hm=4&` }))
      return new Response(JSON.stringify({ refreshed_urls }), { status: 200 })
    }))
    return calls
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    state.instanceToken = null
    state.silentWrites.length = 0
  })

  it("re-signs a member's pasted Discord link with the instance application's token", async () => {
    tick()
    state.instanceToken = 'instance.bot.token'
    const calls = discord()
    const content = [{ type: 'text', text: 'look' }, { type: 'url', url: expired() }]
    const id = post(content)

    const res = await refresh(id)
    expect(res.body).toEqual({ refreshing: true })
    await linkRefresher.drain()

    expect(calls).toEqual([{ url: 'https://discord.com/api/v10/attachments/refresh-urls', auth: 'Bot instance.bot.token', urls: [content[1].url] }])
    expect(state.silentWrites).toHaveLength(1)
    expect(state.silentWrites[0].p_message_id).toBe(id)
    expect(state.silentWrites[0].p_old_content).toEqual(content)
    expect(state.silentWrites[0].p_content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'url', url: `https://cdn.discordapp.com${CLIP}?ex=${hex(clock + 86_400_000)}&is=3&hm=4&` },
    ])
  })

  it('refuses a caller who does not view the channel', async () => {
    tick()
    state.instanceToken = 'instance.bot.token'
    const calls = discord()
    const id = post([{ type: 'url', url: expired() }], { channel_id: STAFF })
    expect((await refresh(id)).status).toBe(403)
    expect((await refresh(post([{ type: 'url', url: expired() }]), 'auth-stranger')).status).toBe(403)
    expect(calls).toEqual([])
  })

  it('leaves a bridged message to its connected bot', async () => {
    tick()
    state.instanceToken = 'instance.bot.token'
    const calls = discord()
    const sent: string[] = []
    ;(gateway as any).connections.set({ readyState: 1, send: (frame: string) => sent.push(frame), close() {} }, {
      botId: BRIDGE_BOT, username: 'bridge', scopes: [], lastHeartbeat: Date.now(), sessionId: 's-refresh', tokenHash: 'h-refresh',
    })
    const content = [{ type: 'file', url: expired(), fileName: 'clip.mp4' }]
    const id = post(content, { bot_id: BRIDGE_BOT })

    expect((await refresh(id)).body).toEqual({ refreshing: true })
    expect(sent.map((f) => JSON.parse(f))).toEqual([
      { op: 0, t: 'REFRESH_ATTACHMENTS', d: { messageId: id, channelId: GENERAL, content } },
    ])
    expect(calls).toEqual([])
  })

  it('re-signs a bridged message itself while its bridge is offline, and says so without an instance application', async () => {
    tick()
    const offlineBot = '00000000-0000-0000-0000-0000000000b7'
    const calls = discord()
    const orphan = post([{ type: 'url', url: expired() }], { bot_id: offlineBot })
    expect((await refresh(orphan)).body).toEqual({ refreshing: false, reason: 'bridge_offline' })

    tick()
    state.instanceToken = 'instance.bot.token'
    const id = post([{ type: 'url', url: expired() }], { bot_id: offlineBot })
    expect((await refresh(id)).body).toEqual({ refreshing: true })
    await linkRefresher.drain()
    expect(calls).toHaveLength(1)
    expect(state.silentWrites.map((w) => w.p_message_id)).toEqual([id])
  })

  it('counts a bridged message against its Discord author, not against the whole bridge', async () => {
    tick()
    state.instanceToken = 'instance.bot.token'
    discord()
    const offlineBot = '00000000-0000-0000-0000-0000000000b8'
    const answers: unknown[] = []
    for (let i = 0; i < 35; i++) {
      const id = post([{ type: 'url', url: expired() }], {
        bot_id: offlineBot, metadata: { discord_user: { id: String(3_000_000_000_000_000 + i) } },
      })
      answers.push((await refresh(id)).body)
    }
    expect(answers.every((a) => (a as { refreshing?: boolean }).refreshing === true)).toBe(true)
    await linkRefresher.drain()
  })

  it("answers no_signer for a member's link while the instance has no Discord application", async () => {
    tick()
    const calls = discord()
    expect((await refresh(post([{ type: 'url', url: expired() }]))).body).toEqual({ refreshing: false, reason: 'no_signer' })
    expect(calls).toEqual([])
  })

  it('makes no Discord call for a link that has not expired, or a message with no Discord attachment', async () => {
    tick()
    state.instanceToken = 'instance.bot.token'
    const calls = discord()
    const fresh = `https://cdn.discordapp.com${CLIP}?ex=${hex(clock + 3_600_000)}&is=1&hm=2&`
    expect((await refresh(post([{ type: 'url', url: fresh }]))).body).toEqual({ refreshing: false, reason: 'not_expired' })
    expect((await refresh(post([{ type: 'url', url: 'https://example.com/a.mp4' }]))).body).toEqual({ refreshing: false, reason: 'not_applicable' })
    expect(calls).toEqual([])
  })

  it('does nothing while the instance mode is not refresh', async () => {
    tick()
    state.instanceToken = 'instance.bot.token'
    const calls = discord()
    const row = state.db.rows('instance_config').find((r: any) => r.config_key === 'bridge_attachment_mode')
    row.config_value = 'link'
    try {
      expect((await refresh(post([{ type: 'url', url: expired() }]))).body).toEqual({ refreshing: false, reason: 'not_enabled' })
    } finally {
      row.config_value = 'refresh'
    }
    expect(calls).toEqual([])
  })
})
