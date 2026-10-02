import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// voice-channels:{serverId} is private and carries only that server's open
// voice channels: a DM call or another server's channel stays off it, and a
// restricted channel goes on its own voice-channel:{channelId} topic.

const realtime = vi.hoisted(() => {
  const opened: Array<{ topic: string; opts: any; sent: any[]; handlers: Record<string, (p: any) => void> }> = []
  return {
    opened,
    channel: (topic: string, opts: any) => {
      const record = { topic, opts, sent: [] as any[], handlers: {} as Record<string, (p: any) => void> }
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
const voice = vi.hoisted(() => ({ isConnected: false, currentChannelId: null as string | null, currentServerId: null as string | null, localState: { userId: 'me' }, callStartTime: null }))

vi.mock('@/supabase', () => ({
  supabase: {
    channel: realtime.channel,
    removeChannel: async () => 'ok',
    rpc: async (fn: string) => ({ data: fn === 'get_restricted_voice_channels' ? ['voice-staff'] : null, error: null }),
    from: () => ({ upsert: () => ({ then: () => undefined }), delete: () => ({ eq: () => ({ eq: () => ({ then: () => undefined }) }) }) }),
  },
}))
vi.mock('@/services/ProfileService', () => ({ updateUserStatus: vi.fn() }))
vi.mock('@/services/userDataService', () => ({ userDataService: { getAllUsers: () => [], ensureUsersLoaded: vi.fn(async () => undefined) } }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { useServerUsersStore } from '@/stores/useServerUsers'

const S = 'server-a'
const payloads = (i = 0) => realtime.opened[i].sent.map((m) => `${m.payload.event}:${m.payload.channelId}`)

beforeEach(() => {
  setActivePinia(createPinia())
  realtime.opened.length = 0
  Object.assign(voice, { isConnected: false, currentChannelId: null, currentServerId: null })
})

describe('voice-channels broadcast', () => {
  it('opens the server topic, and a topic per viewable restricted channel, as private channels', async () => {
    await useServerUsersStore().setupVoiceChannelBroadcast(S)
    expect(realtime.opened.map((o) => [o.topic, o.opts.config.private])).toEqual([
      [`voice-channels:${S}`, true],
      ['voice-channel:voice-staff', true],
    ])
  })

  it('a restricted channel\'s occupancy goes on its own topic only', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    realtime.opened.forEach((o) => { o.sent.length = 0 })
    await store.joinVoiceChannel(S, 'voice-staff', 'me')
    expect(payloads(0)).toEqual([])
    expect(payloads(1)).toEqual(['user-joined:voice-staff'])
  })

  it('a DM call or another server\'s channel is not announced to this server', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    realtime.opened[0].sent.length = 0

    await store.joinVoiceChannel('dm', 'dm-11111111-1111-1111-1111-111111111111', 'me')
    await store.joinVoiceChannel('dm', 'federated-dm-11111111-1111-1111-1111-111111111111-1', 'me')
    await store.joinVoiceChannel('server-b', 'voice-b', 'me')
    await store.leaveVoiceChannel('dm', 'dm-11111111-1111-1111-1111-111111111111', 'me')
    expect(payloads()).toEqual([])

    await store.joinVoiceChannel(S, 'voice-a', 'me')
    expect(payloads()).toEqual(['user-joined:voice-a'])
  })

  it('answers a state request only with a channel of this server', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    const request = () => realtime.opened[0].handlers['voice-channel-event']({ payload: { event: 'request-state', channelId: '', userId: '' } })
    realtime.opened[0].sent.length = 0

    Object.assign(voice, { isConnected: true, currentChannelId: 'dm-11111111-1111-1111-1111-111111111111', currentServerId: 'dm' })
    await request()
    Object.assign(voice, { currentChannelId: 'voice-b', currentServerId: 'server-b' })
    await request()
    expect(payloads()).toEqual([])

    Object.assign(voice, { currentChannelId: 'voice-a', currentServerId: S })
    await request()
    expect(payloads()).toEqual(['user-joined:voice-a'])
  })
})
