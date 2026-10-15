import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/supabase', () => ({ supabase: { realtime: { isConnected: () => true } } }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p, getStoredInstance: () => null }))
const voice = { isConnected: true, effectiveChannelId: 'ch-1', currentChannelId: 'ch-1' }
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))
vi.mock('@/services/webrtcManager', () => ({ webrtcManager: { sendActivity: vi.fn() } }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))

const { useActivitiesStore } = await import('@/stores/activities')

const state = (over: Record<string, unknown> = {}) => ({
  channel_id: 'ch-1', server_id: 's', source: 'youtube', item: { video_id: 'dQw4w9WgXcQ' }, queue: [],
  playing: true, position_ms: 0, position_at: 1000, rate: 1, controls: 'everyone', host_id: 'p1',
  revision: 1, started_at: '2026-10-14T10:00:00Z', ...over,
}) as any

beforeEach(() => setActivePinia(createPinia()))

describe('activities store', () => {
  it('applies a newer revision of the run it holds and ignores an older one', () => {
    const store = useActivitiesStore()
    expect(store.apply('ch-1', state({ revision: 3 }), true)).toBe(true)
    expect(store.apply('ch-1', state({ revision: 2, playing: false }), true)).toBe(false)
    expect(store.current?.playing).toBe(true)
    expect(store.apply('ch-1', state({ revision: 4, playing: false }), false)).toBe(true)
    expect(store.current?.playing).toBe(false)
  })

  it('takes a later run whatever its revision, and ignores an earlier one', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state({ revision: 9 }), true)
    expect(store.apply('ch-1', state({ revision: 1, started_at: '2026-10-14T11:00:00Z' }), false)).toBe(true)
    expect(store.apply('ch-1', state({ revision: 20, started_at: '2026-10-14T09:00:00Z' }), false)).toBe(false)
  })

  it('ends an activity only from the database', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state(), true)
    expect(store.apply('ch-1', null, false)).toBe(false)
    expect(store.current).not.toBeNull()
    expect(store.apply('ch-1', null, true)).toBe(true)
    expect(store.current).toBeNull()
  })

  it('takes peer states for the call it is in only', () => {
    const store = useActivitiesStore()
    store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-2', activity: state({ channel_id: 'ch-2' }) } })
    expect(store.byChannel['ch-2']).toBeUndefined()
    store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1', activity: state({ channel_id: 'other' }) } })
    expect(store.current).toBeNull()
    store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1', activity: state() } })
    expect(store.current?.source).toBe('youtube')
  })

  it('hides an activity for this client until it ends', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state({ host_id: 'me' }), true)
    store.hide('ch-1', true)
    expect(store.playingHere).toBe(false)
    store.apply('ch-1', null, true)
    store.apply('ch-1', state({ host_id: 'me', started_at: '2026-10-14T12:00:00Z' }), true)
    expect(store.playingHere).toBe(true)
  })
})

describe('consent', () => {
  it('plays a run this member started', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state({ host_id: 'me' }), true)
    expect(store.playingHere).toBe(true)
    expect(store.waiting).toBeNull()
  })

  it("waits for Join on someone else's run, and Join plays it", () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state(), true)
    expect(store.playingHere).toBe(false)
    expect(store.invited).toBe(true)
    store.join()
    expect(store.playingHere).toBe(true)
    expect(store.waiting).toBeNull()
  })

  it('keeps a joined run through its next items, and asks again for a new run', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state(), true)
    store.join()
    store.apply('ch-1', state({ revision: 2, item: { video_id: 'aaaaaaaaaaa' } }), true)
    expect(store.playingHere).toBe(true)
    store.apply('ch-1', state({ revision: 1, started_at: '2026-10-14T12:00:00Z' }), true)
    expect(store.playingHere).toBe(false)
    expect(store.invited).toBe(true)
  })

  it('Not now keeps it off and leaves it joinable', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state(), true)
    store.hide('ch-1', true)
    expect(store.invited).toBe(false)
    expect(store.waiting?.channel_id).toBe('ch-1')
    store.join()
    expect(store.playingHere).toBe(true)
  })

  it('a new run asks again after Not now on the previous one', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state(), true)
    store.hide('ch-1', true)
    store.apply('ch-1', state({ started_at: '2026-10-14T12:00:00Z' }), true)
    expect(store.invited).toBe(true)
  })
})
