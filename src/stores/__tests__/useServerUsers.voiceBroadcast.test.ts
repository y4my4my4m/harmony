import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// voice-channels:{serverId} and voice-channel:{channelId} are private and take no client's send.
// A local server's rows announce its occupancy; a copy's callers go through voice_channel_announce,
// and a DM call or another server's channel is not announced at all.

const realtime = vi.hoisted(() => {
  const opened: Array<{ topic: string; opts: any; sent: any[]; handlers: Record<string, (p: any) => void>; status?: (s: string, e?: Error) => void; ch?: any }> = []
  return {
    opened,
    restricted: ['voice-staff'] as string[],
    removed: [] as string[],
    channel: (topic: string, opts: any) => {
      const record: (typeof opened)[number] = { topic, opts, sent: [] as any[], handlers: {} as Record<string, (p: any) => void> }
      opened.push(record)
      const ch: any = {
        topic,
        on: (_type: string, filter: { event: string }, cb: (p: any) => void) => { record.handlers[filter.event] = cb; return ch },
        subscribe: (cb?: (s: string, e?: Error) => void) => { record.status = cb; return ch },
        unsubscribe: async () => 'ok',
        send: (msg: any) => { record.sent.push(msg); return Promise.resolve('ok') },
      }
      record.ch = ch
      return ch
    },
  }
})
const rpcs = vi.hoisted(() => [] as Array<{ fn: string; args: any }>)
const voice = vi.hoisted(() => ({ isConnected: false, currentChannelId: null as string | null, currentServerId: null as string | null, localState: { userId: 'me' }, callStartTime: null }))

vi.mock('@/supabase', () => ({
  supabase: {
    channel: realtime.channel,
    removeChannel: async (ch: any) => { realtime.removed.push(ch.topic); return 'ok' },
    rpc: async (fn: string, args: any) => {
      rpcs.push({ fn, args })
      return { data: fn === 'get_restricted_voice_channels' ? realtime.restricted : null, error: null }
    },
    from: () => ({ upsert: () => ({ then: () => undefined }), delete: () => ({ eq: () => ({ eq: () => ({ then: () => undefined }) }) }) }),
  },
}))
vi.mock('@/services/ProfileService', () => ({ updateUserStatus: vi.fn() }))
vi.mock('@/services/userDataService', () => ({ userDataService: { getAllUsers: () => [], ensureUsersLoaded: vi.fn(async () => undefined) } }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const moderation = vi.hoisted(() => ({ apply: vi.fn(), load: vi.fn(async () => undefined), recheckGrants: vi.fn(async () => undefined) }))
vi.mock('@/stores/voiceModeration', () => ({ useVoiceModerationStore: () => moderation }))
const caps = vi.hoisted(() => ({ voiceAnnounce: true }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: (name: string) => name !== 'voice-announce' || caps.voiceAnnounce }))

import { MAX_RESTRICTED_VOICE_TOPICS, UNWATCHED_VOICE_READ_MS, useServerUsersStore } from '@/stores/useServerUsers'

const S = 'server-a'
const allSent = () => realtime.opened.flatMap((o) => o.sent)
const announced = () => rpcs.filter((r) => r.fn === 'voice_channel_announce')
  .map((r) => `${r.args.p_event}:${r.args.p_channel_id}`)

beforeEach(() => {
  setActivePinia(createPinia())
  realtime.opened.length = 0
  realtime.removed.length = 0
  realtime.restricted = ['voice-staff']
  rpcs.length = 0
  caps.voiceAnnounce = true
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

  it('a local server\'s call sends nothing: its row announces it', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    await store.joinVoiceChannel(S, 'voice-a', 'me')
    await store.leaveVoiceChannel(S, 'voice-a', 'me')
    expect(allSent()).toEqual([])
    expect(announced()).toEqual([])
  })

  it('a copy\'s call goes through voice_channel_announce, on no topic', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S, { local: false })
    expect(announced()).toEqual(['request-state:null'])
    rpcs.length = 0

    await store.joinVoiceChannel(S, 'voice-a', 'me', false)
    await store.leaveVoiceChannel(S, 'voice-a', 'me', false)
    expect(announced()).toEqual(['user-joined:voice-a', 'user-left:voice-a'])
    expect(allSent()).toEqual([])
  })

  it('a DM call or another server\'s channel is not announced to this server', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S, { local: false })
    rpcs.length = 0

    await store.joinVoiceChannel('dm', 'dm-11111111-1111-1111-1111-111111111111', 'me')
    await store.joinVoiceChannel('dm', 'federated-dm-11111111-1111-1111-1111-111111111111-1', 'me')
    await store.joinVoiceChannel('server-b', 'voice-b', 'me', false)
    await store.leaveVoiceChannel('dm', 'dm-11111111-1111-1111-1111-111111111111', 'me')
    expect(announced()).toEqual([])
  })

  it('answers a state request only with a channel of this server, and only on a copy', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S, { local: false })
    const request = () => realtime.opened[0].handlers['voice-channel-event']({ payload: { event: 'request-state', userId: '', channelId: '' } })
    rpcs.length = 0

    Object.assign(voice, { isConnected: true, currentChannelId: 'dm-11111111-1111-1111-1111-111111111111', currentServerId: S })
    await request()
    Object.assign(voice, { currentChannelId: 'voice-b', currentServerId: 'server-b' })
    await request()
    expect(announced()).toEqual([])

    Object.assign(voice, { currentChannelId: 'voice-a', currentServerId: S })
    await request()
    expect(announced()).toEqual(['user-joined:voice-a'])
  })

  describe('a burst of state requests', () => {
    const request = () => realtime.opened[0].handlers['voice-channel-event']({ payload: { event: 'request-state', userId: '', channelId: '' } })

    beforeEach(async () => {
      vi.useFakeTimers()
      await useServerUsersStore().setupVoiceChannelBroadcast(S, { local: false })
      rpcs.length = 0
      Object.assign(voice, { isConnected: true, currentChannelId: 'voice-a', currentServerId: S })
    })
    afterEach(() => { vi.useRealTimers() })

    it('is answered once at once, and once more when the interval ends', () => {
      for (let i = 0; i < 50; i++) request()
      expect(announced()).toEqual(['user-joined:voice-a'])

      vi.advanceTimersByTime(4_999)
      expect(announced()).toHaveLength(1)

      vi.advanceTimersByTime(1)
      expect(announced()).toEqual(['user-joined:voice-a', 'user-joined:voice-a'])

      vi.advanceTimersByTime(60_000)
      expect(announced()).toHaveLength(2)
    })

    it('gets no trailing answer from a caller who has left', () => {
      request()
      request()
      Object.assign(voice, { isConnected: false, currentChannelId: null, currentServerId: null })
      vi.advanceTimersByTime(5_000)
      expect(announced()).toEqual(['user-joined:voice-a'])
    })

    it('holds no timer once the broadcasts are closed', () => {
      const store = useServerUsersStore()
      request()
      request()
      expect(store.voiceStateAnswerTimer).not.toBeNull()
      store.cleanup()
      expect(store.voiceStateAnswerTimer).toBeNull()
      vi.advanceTimersByTime(5_000)
      expect(announced()).toEqual(['user-joined:voice-a'])
    })
  })
})

// The native app on an instance before 20261110100001: no row announces a join and
// voice_channel_announce is absent, so the client sends on the topics as 1.9.4 did.
describe('an instance without voice-announce', () => {
  const sentOn = () => realtime.opened.flatMap((o) => o.sent.map((m) => `${o.topic} ${m.payload.event}:${m.payload.channelId}`))
  const clearSent = () => { for (const o of realtime.opened) o.sent.length = 0 }

  beforeEach(() => { caps.voiceAnnounce = false })

  it('requests state on every topic of the server', async () => {
    await useServerUsersStore().setupVoiceChannelBroadcast(S)
    expect(sentOn()).toEqual([`voice-channels:${S} request-state:`, 'voice-channel:voice-staff request-state:'])
    expect(announced()).toEqual([])
  })

  it('sends a local server\'s join and leave on the server topic', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    clearSent()
    await store.joinVoiceChannel(S, 'voice-a', 'me')
    await store.leaveVoiceChannel(S, 'voice-a', 'me')
    expect(sentOn()).toEqual([`voice-channels:${S} user-joined:voice-a`, `voice-channels:${S} user-left:voice-a`])
    expect(realtime.opened[0].sent[0]).toMatchObject({ type: 'broadcast', event: 'voice-channel-event', payload: { userId: 'me' } })
    expect(announced()).toEqual([])
  })

  it('sends a restricted channel\'s join on its own topic only', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    clearSent()
    await store.joinVoiceChannel(S, 'voice-staff', 'me')
    expect(sentOn()).toEqual(['voice-channel:voice-staff user-joined:voice-staff'])
  })

  it('sends a copy\'s call on the topic and calls no voice_channel_announce', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S, { local: false })
    clearSent()
    await store.joinVoiceChannel(S, 'voice-a', 'me', false)
    await store.leaveVoiceChannel(S, 'voice-a', 'me', false)
    expect(sentOn()).toEqual([`voice-channels:${S} user-joined:voice-a`, `voice-channels:${S} user-left:voice-a`])
    expect(announced()).toEqual([])
  })

  it('answers a state request on the topic', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    clearSent()
    Object.assign(voice, { isConnected: true, currentChannelId: 'voice-a', currentServerId: S })
    await realtime.opened[0].handlers['voice-channel-event']({ payload: { event: 'request-state', userId: '', channelId: '' } })
    expect(sentOn()).toEqual([`voice-channels:${S} user-joined:voice-a`])
  })

  it('sends nothing for a DM call or another server\'s channel', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    clearSent()
    await store.joinVoiceChannel('dm', 'dm-11111111-1111-1111-1111-111111111111', 'me')
    await store.joinVoiceChannel('server-b', 'voice-b', 'me', false)
    expect(sentOn()).toEqual([])
  })
})

describe('restricted voice topics past the limit', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `voice-${i}`)
  const openTopics = () => realtime.opened.map((o) => o.topic).filter((t) => t.startsWith('voice-channel:') && !realtime.removed.includes(t))
  const refused = new Error('"Unauthorized: You do not have permissions to read from this Channel topic: x"')

  it('opens the limit and leaves the rest without a topic', async () => {
    realtime.restricted = ids(MAX_RESTRICTED_VOICE_TOPICS + 30)
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    expect(openTopics()).toHaveLength(MAX_RESTRICTED_VOICE_TOPICS)
    expect(store.unwatchedRestrictedVoice).toHaveLength(30)
    store.closeRestrictedVoiceBroadcasts()
  })

  it('an unwatched channel the caller joins gets its topic, and the oldest topic gives way', async () => {
    realtime.restricted = ids(MAX_RESTRICTED_VOICE_TOPICS + 1)
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    const last = `voice-${MAX_RESTRICTED_VOICE_TOPICS}`

    await store.joinVoiceChannel(S, last, 'me')

    expect(realtime.opened.some((o) => o.topic === `voice-channel:${last}`)).toBe(true)
    expect(allSent()).toEqual([])
    expect(realtime.removed).toEqual(['voice-channel:voice-0'])
    expect(Object.keys(store.restrictedVoiceBroadcasts)).toHaveLength(MAX_RESTRICTED_VOICE_TOPICS)
    expect(store.unwatchedRestrictedVoice).toEqual(['voice-0'])
    store.closeRestrictedVoiceBroadcasts()
  })

  it('reads the roster on a timer only while a channel has no topic', async () => {
    vi.useFakeTimers()
    try {
      const store = useServerUsersStore()
      const read = vi.spyOn(store, 'reloadVoiceRoster').mockResolvedValue(undefined)

      await store.setupVoiceChannelBroadcast(S)
      read.mockClear()
      await vi.advanceTimersByTimeAsync(UNWATCHED_VOICE_READ_MS * 2)
      expect(read).not.toHaveBeenCalled()

      realtime.restricted = ids(MAX_RESTRICTED_VOICE_TOPICS + 1)
      await store.setupVoiceChannelBroadcast(S)
      read.mockClear()
      await vi.advanceTimersByTimeAsync(UNWATCHED_VOICE_READ_MS * 2)
      expect(read).toHaveBeenCalledTimes(2)

      // Two setups for one server, as a fast switch away and back runs them, leave one timer.
      await Promise.all([store.setupVoiceChannelBroadcast(S), store.setupVoiceChannelBroadcast(S)])
      read.mockClear()
      await vi.advanceTimersByTimeAsync(UNWATCHED_VOICE_READ_MS)
      expect(read).toHaveBeenCalledTimes(1)

      read.mockClear()
      store.closeRestrictedVoiceBroadcasts()
      await vi.advanceTimersByTimeAsync(UNWATCHED_VOICE_READ_MS * 2)
      expect(read).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a refused topic is removed, and its channel is not announced to the whole server', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    const topic = realtime.opened[1]

    topic.status!('CHANNEL_ERROR', refused)

    expect(realtime.removed).toEqual(['voice-channel:voice-staff'])
    expect(store.restrictedVoiceBroadcasts).toEqual({})
    expect(store.unwatchedRestrictedVoice).toEqual(['voice-staff'])

    await store.joinVoiceChannel(S, 'voice-staff', 'me')
    expect(allSent()).toEqual([])
  })

  it('another channel error leaves the topic to realtime-js\'s rejoin', async () => {
    const store = useServerUsersStore()
    await store.setupVoiceChannelBroadcast(S)
    realtime.opened[1].status!('CHANNEL_ERROR', new Error('"ChannelRateLimitReached: Too many channels"'))
    expect(realtime.removed).toEqual([])
    expect(Object.keys(store.restrictedVoiceBroadcasts)).toEqual(['voice-staff'])
  })
})

describe('voice-grants', () => {
  it('passes a permission change of this server to the voice moderation store', async () => {
    await useServerUsersStore().setupVoiceChannelBroadcast(S)
    const deliver = (payload: any, i = 0) => realtime.opened[i].handlers['voice-channel-event']({ payload })
    deliver({ event: 'voice-grants', serverId: S, channelId: null, userId: 'me' })
    deliver({ event: 'voice-grants', serverId: 'server-b', channelId: null, userId: null })
    deliver({ event: 'voice-grants', serverId: S, channelId: 'voice-staff', userId: null }, 1)
    expect(moderation.recheckGrants.mock.calls).toEqual([[S, null, 'me'], [S, 'voice-staff', null]])
  })
})
