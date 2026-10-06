import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Server-side removal of a voice_channel_participants row arrives as user-left with
// reason 'reconciled'. A client still in that call writes its row back; any other
// user-left only updates occupancy. markVoiceTransport and leaveVoiceChannelOnUnload
// write this client's own row.

const realtime = vi.hoisted(() => {
  const opened: Array<{ topic: string; sent: any[]; handlers: Record<string, (p: any) => void> }> = []
  return {
    opened,
    channel: (topic: string) => {
      const record = { topic, sent: [] as any[], handlers: {} as Record<string, (p: any) => void> }
      opened.push(record)
      const ch: any = {
        on: (_type: string, filter: { event: string }, cb: (p: any) => void) => { record.handlers[filter.event] = cb; return ch },
        subscribe: async () => ch,
        unsubscribe: async () => 'ok',
        send: (msg: any) => { record.sent.push(msg); return Promise.resolve('ok') },
      }
      return ch
    },
  }
})
const db = vi.hoisted(() => ({ writes: [] as Array<{ op: string; row?: any; filters: string[] }>, upsertDelay: 0 }))
const voice = vi.hoisted(() => ({
  isConnected: false,
  currentChannelId: null as string | null,
  currentServerId: null as string | null,
  isFederatedChannel: false,
  localState: { userId: 'me' },
  callStartTime: null,
}))

vi.mock('@/supabase', () => {
  const builder = (op: string, row?: any) => {
    const entry = { op, row, filters: [] as string[] }
    const b: any = {
      eq: (col: string, val: string) => { entry.filters.push(`${col}=${val}`); return b },
      then: (resolve: any) => {
        const done = () => { db.writes.push(entry); return resolve({ error: null }) }
        return op === 'upsert' && db.upsertDelay ? new Promise((r) => setTimeout(r, db.upsertDelay)).then(done) : Promise.resolve().then(done)
      },
    }
    return b
  }
  return {
    SUPABASE_URL: 'https://db.harmony.test',
    SUPABASE_ANON_KEY: 'anon-key',
    supabase: {
      channel: realtime.channel,
      removeChannel: async () => 'ok',
      rpc: async () => ({ data: [], error: null }),
      from: () => ({
        upsert: (row: any) => builder('upsert', row),
        update: (row: any) => builder('update', row),
        delete: () => builder('delete'),
      }),
    },
  }
})
vi.mock('@/services/ProfileService', () => ({ updateUserStatus: vi.fn() }))
vi.mock('@/services/userDataService', () => ({ userDataService: { getAllUsers: () => [], ensureUsersLoaded: vi.fn(async () => undefined) } }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { useServerUsersStore } from '@/stores/useServerUsers'

const S = 'server-a'
const C = 'voice-a'
const sent = () => realtime.opened[0].sent.map((m) => `${m.payload.event}:${m.payload.userId}`)
const deliver = (payload: any) => realtime.opened[0].handlers['voice-channel-event']({ payload })
const flush = () => new Promise((r) => setTimeout(r, 0))

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  setActivePinia(createPinia())
  realtime.opened.length = 0
  db.writes.length = 0
  db.upsertDelay = 0
  Object.assign(voice, { isConnected: false, currentChannelId: null, currentServerId: null, isFederatedChannel: false })
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  await useServerUsersStore().setupVoiceChannelBroadcast(S)
  realtime.opened[0].sent.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reconciled user-left', () => {
  it('writes the row back when this client is still in the call', async () => {
    const store = useServerUsersStore()
    store.usersInVoiceChannels[C] = ['me', 'bob']
    Object.assign(voice, { isConnected: true, currentChannelId: C, currentServerId: S })

    deliver({ event: 'user-left', userId: 'me', channelId: C, reason: 'reconciled' })
    await flush()

    expect(db.writes.map((w) => [w.op, w.row?.user_id, w.row?.channel_id])).toEqual([['upsert', 'me', C]])
    expect(sent()).toEqual(['user-joined:me'])
    expect(store.getUsersInVoiceChannel(C)).toEqual(['me', 'bob'])
  })

  it('removes this client when it is no longer in that call', async () => {
    const store = useServerUsersStore()
    store.usersInVoiceChannels[C] = ['me']
    Object.assign(voice, { isConnected: true, currentChannelId: 'voice-b', currentServerId: S })

    deliver({ event: 'user-left', userId: 'me', channelId: C, reason: 'reconciled' })
    await flush()

    expect(db.writes).toEqual([])
    expect(store.getUsersInVoiceChannel(C)).toEqual([])
  })

  it('does not answer its own leave', async () => {
    const store = useServerUsersStore()
    store.usersInVoiceChannels[C] = ['me']
    Object.assign(voice, { isConnected: true, currentChannelId: C, currentServerId: S })

    deliver({ event: 'user-left', userId: 'me', channelId: C })
    await flush()

    expect(db.writes).toEqual([])
    expect(store.getUsersInVoiceChannel(C)).toEqual([])
  })

  it('removes another user', async () => {
    const store = useServerUsersStore()
    store.usersInVoiceChannels[C] = ['me', 'ghost']
    Object.assign(voice, { isConnected: true, currentChannelId: C, currentServerId: S })

    deliver({ event: 'user-left', userId: 'ghost', channelId: C, reason: 'reconciled' })
    await flush()

    expect(db.writes).toEqual([])
    expect(store.getUsersInVoiceChannel(C)).toEqual(['me'])
  })
})

describe('own row writes', () => {
  it('records the P2P transport after the join upsert lands', async () => {
    db.upsertDelay = 10
    const store = useServerUsersStore()
    await store.joinVoiceChannel(S, C, 'me')
    await store.markVoiceTransport(C, 'me', 'p2p')

    expect(db.writes.map((w) => w.op)).toEqual(['upsert', 'update'])
    expect(db.writes[1]).toEqual({ op: 'update', row: { metadata: { transport: 'p2p' } }, filters: [`channel_id=${C}`, 'user_id=me'] })
  })

  it('leaves from an unloading page with a keepalive delete and a user-left broadcast', () => {
    useServerUsersStore().leaveVoiceChannelOnUnload(S, C, 'me', 'access-token')

    expect(fetchMock).toHaveBeenCalledWith(
      `https://db.harmony.test/rest/v1/voice_channel_participants?channel_id=eq.${C}&user_id=eq.me`,
      {
        method: 'DELETE',
        keepalive: true,
        headers: { apikey: 'anon-key', Authorization: 'Bearer access-token' },
      },
    )
    expect(sent()).toEqual(['user-left:me'])
  })

  it('does nothing on unload for a DM call or without a session', () => {
    const store = useServerUsersStore()
    store.leaveVoiceChannelOnUnload('dm', 'dm-11111111-1111-1111-1111-111111111111', 'me', 'access-token')
    store.leaveVoiceChannelOnUnload(S, C, 'me', undefined)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sent()).toEqual([])
  })
})
