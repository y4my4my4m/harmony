import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The roster of a local server is read from voice_channel_participants on setup, on each
// SUBSCRIBED of its topic, when the tab is shown again and when the network returns, and
// replaces that server's channels alone. A user-left the database sends for this client's
// own row while it is still in the call writes the row back.

const realtime = vi.hoisted(() => {
  const opened: Array<{ topic: string; sent: any[]; handlers: Record<string, (p: any) => void>; status?: (s: string) => void }> = []
  return {
    opened,
    channel: (topic: string) => {
      const record = { topic, sent: [] as any[], handlers: {} as Record<string, (p: any) => void>, status: undefined as undefined | ((s: string) => void) }
      opened.push(record)
      const ch: any = {
        on: (_type: string, filter: { event: string }, cb: (p: any) => void) => { record.handlers[filter.event] = cb; return ch },
        subscribe: (cb?: (s: string) => void) => { record.status = cb; return ch },
        unsubscribe: async () => 'ok',
        send: (msg: any) => { record.sent.push(msg); return Promise.resolve('ok') },
      }
      return ch
    },
  }
})
const db = vi.hoisted(() => ({
  rows: [] as Array<{ channel_id: string; user_id: string; server_id: string }>,
  reads: [] as string[],
  // Resolves the next roster read when set; the read waits for it.
  hold: null as null | Promise<void>,
  writes: [] as Array<{ op: string; row?: any }>,
  rpcs: [] as Array<{ fn: string; args: any }>,
  touchAnswer: true as boolean,
  // profiles.is_local = true
  localIds: [] as string[],
  profileReads: [] as string[][],
  // Resolves the next profiles read when set; the read waits for it.
  profilesHold: null as null | Promise<void>,
}))
const voice = vi.hoisted(() => ({
  isConnected: false,
  currentChannelId: null as string | null,
  currentServerId: null as string | null,
  optimisticChannelId: null as string | null,
  optimisticServerId: null as string | null,
  isFederatedChannel: false,
  connectionMode: 'livekit' as 'livekit' | 'p2p' | null,
  localState: { userId: 'me' },
  callStartTime: null,
}))

vi.mock('@/supabase', () => {
  const write = (op: string, row?: any) => {
    const b: any = {
      eq: () => b,
      then: (resolve: any) => Promise.resolve().then(() => { db.writes.push({ op, row }); return resolve({ error: null }) }),
    }
    return b
  }
  return {
    SUPABASE_URL: 'https://db.harmony.test',
    SUPABASE_ANON_KEY: 'anon-key',
    supabase: {
      channel: realtime.channel,
      removeChannel: async () => 'ok',
      rpc: async (fn: string, args: any) => {
        db.rpcs.push({ fn, args })
        if (fn === 'touch_voice_participant') return { data: db.touchAnswer, error: null }
        return { data: [], error: null }
      },
      from: (table: string) => ({
        select: () => ({
          in: (_col: string, ids: string[]) => ({
            eq: async () => {
              if (table !== 'profiles') throw new Error(`unexpected read of ${table}`)
              db.profileReads.push(ids)
              if (db.profilesHold) await db.profilesHold
              return { data: ids.filter((id) => db.localIds.includes(id)).map((id) => ({ id })), error: null }
            },
          }),
          eq: async (_col: string, serverId: string) => {
            db.reads.push(serverId)
            if (db.hold) await db.hold
            return { data: db.rows.filter((r) => r.server_id === serverId).map(({ channel_id, user_id }) => ({ channel_id, user_id })), error: null }
          },
        }),
        upsert: (row: any) => write('upsert', row),
        update: (row: any) => write('update', row),
        delete: () => write('delete'),
      }),
    },
  }
})
vi.mock('@/services/ProfileService', () => ({ updateUserStatus: vi.fn() }))
vi.mock('@/services/userDataService', () => ({ userDataService: { getAllUsers: () => [], ensureUsersLoaded: vi.fn(async () => undefined) } }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))
vi.mock('@/stores/voiceModeration', () => ({ useVoiceModerationStore: () => ({ load: vi.fn(async () => undefined), apply: vi.fn(), recheckGrants: vi.fn() }) }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { useServerUsersStore } from '@/stores/useServerUsers'

const S = 'server-a'
const T = 'server-b'
const flush = () => new Promise((r) => setTimeout(r, 0))
const topic = (serverId: string) => realtime.opened.filter((o) => o.topic === `voice-channels:${serverId}`).at(-1)!
const deliver = (serverId: string, payload: any) => topic(serverId).handlers['voice-channel-event']({ payload })

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  setActivePinia(createPinia())
  realtime.opened.length = 0
  db.rows = []
  db.reads.length = 0
  db.writes.length = 0
  db.rpcs.length = 0
  db.hold = null
  db.touchAnswer = true
  db.localIds = []
  db.profileReads.length = 0
  db.profilesHold = null
  Object.assign(voice, {
    isConnected: false, currentChannelId: null, currentServerId: null,
    optimisticChannelId: null, optimisticServerId: null, isFederatedChannel: false, connectionMode: 'livekit',
  })
})

afterEach(() => {
  useServerUsersStore().cleanup()
  vi.useRealTimers()
})

describe('voice roster from the database', () => {
  it('reads the server roster on setup', async () => {
    db.rows = [
      { server_id: S, channel_id: 'c1', user_id: 'alice' },
      { server_id: S, channel_id: 'c1', user_id: 'bob' },
      { server_id: S, channel_id: 'c2', user_id: 'carol' },
      { server_id: T, channel_id: 't1', user_id: 'dave' },
    ]
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    expect(store.usersInVoiceChannels).toEqual({ c1: ['alice', 'bob'], c2: ['carol'] })
  })

  it('drops a user who left while this client viewed another server, and keeps that server', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const store = useServerUsersStore()
    db.rows = [{ server_id: S, channel_id: 'c1', user_id: 'alice' }]
    await store.setupVoiceChannelBroadcast(S)
    expect(store.getUsersInVoiceChannel('c1')).toEqual(['alice'])

    db.rows = [{ server_id: T, channel_id: 't1', user_id: 'dave' }]
    await store.setupVoiceChannelBroadcast(T)
    vi.setSystemTime(Date.now() + 120_000)
    // alice's page closed meanwhile: her row is gone, and the user-left went to S's topic.
    await store.setupVoiceChannelBroadcast(S)
    expect(store.getUsersInVoiceChannel('c1')).toEqual([])
    expect(store.getUsersInVoiceChannel('t1')).toEqual(['dave'])
  })

  it('re-reads on every SUBSCRIBED, on the tab shown again and on the network returning', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const store = useServerUsersStore()
    db.rows = [{ server_id: S, channel_id: 'c1', user_id: 'alice' }]
    await store.setupVoiceChannelBroadcast(S)
    expect(db.reads).toEqual([S])

    vi.setSystemTime(Date.now() + 120_000)
    db.rows = []
    topic(S).status?.('SUBSCRIBED')
    await flush()
    expect(db.reads).toEqual([S, S])
    expect(store.getUsersInVoiceChannel('c1')).toEqual([])

    db.rows = [{ server_id: S, channel_id: 'c1', user_id: 'bob' }]
    setVisibility('hidden')
    setVisibility('visible')
    await flush()
    // Shown again within 10 s of the last read: not read again.
    expect(db.reads).toEqual([S, S])
    vi.setSystemTime(Date.now() + 11_000)
    setVisibility('hidden')
    setVisibility('visible')
    await flush()
    expect(db.reads).toEqual([S, S, S])
    expect(store.getUsersInVoiceChannel('c1')).toEqual(['bob'])

    db.rows = []
    vi.setSystemTime(Date.now() + 120_000)
    window.dispatchEvent(new Event('online'))
    await flush()
    expect(db.reads).toEqual([S, S, S, S])
    expect(store.getUsersInVoiceChannel('c1')).toEqual([])
  })

  it('keeps a join that arrives while the read is in flight, and this client in its own call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    Object.assign(voice, { isConnected: true, currentChannelId: 'c2', currentServerId: S })
    vi.setSystemTime(Date.now() + 120_000)

    let release!: () => void
    db.hold = new Promise<void>((r) => { release = r })
    const reload = store.reloadVoiceRoster(S)
    deliver(S, { event: 'user-joined', userId: 'erin', channelId: 'c1' })
    release()
    await reload
    expect(store.getUsersInVoiceChannel('c1')).toEqual(['erin'])
    expect(store.getUsersInVoiceChannel('c2')).toEqual(['me'])
  })

  it("reads a remote server copy's roster: its host's presence rows", async () => {
    // Someone on the host joined while this client viewed another server; the row is all there is.
    db.rows = [{ server_id: S, channel_id: 'c1', user_id: 'spartzy' }]
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S, { local: false })
    await flush()
    expect(db.reads).toEqual([S])
    expect(store.getUsersInVoiceChannel('c1')).toEqual(['spartzy'])

    db.rows = []
    deliver(S, { event: 'user-joined', userId: 'remote', channelId: 'c2' })
    topic(S).status?.('SUBSCRIBED')
    await flush()
    expect(store.getUsersInVoiceChannel('c2')).toEqual(['remote'])
  })

  it("keeps this instance's callers on a copy, whose rows name the host's people only", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    db.rows = [{ server_id: S, channel_id: 'c1', user_id: 'hostA' }]
    db.localIds = ['neighbour', 'me']
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S, { local: false })
    await flush()
    deliver(S, { event: 'user-joined', userId: 'neighbour', channelId: 'c1' })
    deliver(S, { event: 'user-joined', userId: 'hostB', channelId: 'c1' })

    // Past the grace: the read decides. hostB has no row and is the host's; hostA left.
    vi.setSystemTime(Date.now() + 60_000)
    db.rows = [{ server_id: S, channel_id: 'c1', user_id: 'hostA' }]
    topic(S).status?.('SUBSCRIBED')
    await flush()
    await flush()
    expect([...store.getUsersInVoiceChannel('c1')].sort()).toEqual(['hostA', 'neighbour'])
    expect(db.profileReads).toEqual([['neighbour', 'hostB']])

    db.rows = []
    topic(S).status?.('SUBSCRIBED')
    await flush()
    await flush()
    expect(store.getUsersInVoiceChannel('c1')).toEqual(['neighbour'])
  })

  it('keeps a join that arrives while the locality read is in flight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    db.rows = [{ server_id: S, channel_id: 'c1', user_id: 'hostA' }]
    db.localIds = ['neighbour']
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S, { local: false })
    await flush()
    deliver(S, { event: 'user-joined', userId: 'neighbour', channelId: 'c1' })
    vi.setSystemTime(Date.now() + 60_000)

    let release = () => {}
    db.profilesHold = new Promise<void>((resolve) => { release = resolve })
    topic(S).status?.('SUBSCRIBED')
    await flush()
    expect(db.profileReads).toEqual([['neighbour']])
    deliver(S, { event: 'user-joined', userId: 'hostB', channelId: 'c1' })
    release()
    await flush()
    await flush()
    expect([...store.getUsersInVoiceChannel('c1')].sort()).toEqual(['hostA', 'hostB', 'neighbour'])
  })

  it('keeps this client in its own call on a copy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    Object.assign(voice, { isConnected: true, currentChannelId: 'c1', currentServerId: S, isFederatedChannel: true })
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S, { local: false })
    await flush()
    expect(store.getUsersInVoiceChannel('c1')).toEqual(['me'])

    vi.setSystemTime(Date.now() + 60_000)
    topic(S).status?.('SUBSCRIBED')
    await flush()
    await flush()
    expect(store.getUsersInVoiceChannel('c1')).toEqual(['me'])
  })

  it('reads no profiles for a local server or a copy whose rows cover the roster', async () => {
    db.rows = [{ server_id: S, channel_id: 'c1', user_id: 'hostA' }, { server_id: T, channel_id: 't1', user_id: 'x' }]
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S, { local: false })
    await flush()
    topic(S).status?.('SUBSCRIBED')
    await flush()
    await store.setupVoiceChannelBroadcast(T)
    await flush()
    expect(db.profileReads).toEqual([])
  })
})

describe('database user-left for this client', () => {
  it("writes the row back on 'left' while still in that call", async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    store.usersInVoiceChannels.c1 = ['me', 'bob']
    Object.assign(voice, { isConnected: true, currentChannelId: 'c1', currentServerId: S })
    topic(S).sent.length = 0

    deliver(S, { event: 'user-left', userId: 'me', channelId: 'c1', reason: 'left' })
    await flush()
    expect(db.writes.map((w) => [w.op, w.row?.user_id, w.row?.channel_id])).toEqual([['upsert', 'me', 'c1']])
    expect(store.getUsersInVoiceChannel('c1')).toEqual(['me', 'bob'])
    expect(topic(S).sent).toEqual([])
  })

  it('marks a P2P row again and stamps it when writing it back', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    Object.assign(voice, { isConnected: true, currentChannelId: 'c1', currentServerId: S, connectionMode: 'p2p' })

    deliver(S, { event: 'user-left', userId: 'me', channelId: 'c1', reason: 'reconciled' })
    await vi.waitFor(() => expect(db.rpcs.map((r) => r.fn)).toContain('touch_voice_participant'))
    expect(db.writes.map((w) => w.op)).toEqual(['upsert', 'update'])
    expect(db.writes[1].row).toEqual({ metadata: { transport: 'p2p' } })
  })

  it('leaves on a moderation removal', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    store.usersInVoiceChannels.c1 = ['me']
    Object.assign(voice, { isConnected: true, currentChannelId: 'c1', currentServerId: S })

    deliver(S, { event: 'user-left', userId: 'me', channelId: 'c1', reason: 'disconnected' })
    await flush()
    expect(db.writes).toEqual([])
    expect(store.getUsersInVoiceChannel('c1')).toEqual([])
  })
})

describe('touchVoiceParticipant', () => {
  it('writes the row back when the server no longer has it', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    Object.assign(voice, { isConnected: true, currentChannelId: 'c1', currentServerId: S, connectionMode: 'p2p' })
    db.touchAnswer = false
    await store.touchVoiceParticipant(S, 'c1', 'me')
    expect(db.rpcs.filter((r) => r.fn === 'touch_voice_participant')).toHaveLength(2)
    expect(db.writes.map((w) => w.op)).toEqual(['upsert', 'update'])
  })

  it('writes nothing while the row is there', async () => {
    const store = useServerUsersStore()
    await store.touchVoiceParticipant(S, 'c1', 'me')
    expect(db.rpcs).toEqual([{ fn: 'touch_voice_participant', args: { p_channel_id: 'c1' } }])
    expect(db.writes).toEqual([])
  })
})
