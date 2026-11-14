import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/supabase', () => ({ supabase: { realtime: { isConnected: () => true } } }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p, getStoredInstance: () => null }))
const voice = { isConnected: true, effectiveChannelId: 'ch-1', currentChannelId: 'ch-1' }
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))
vi.mock('@/services/webrtcManager', () => ({ webrtcManager: { sendActivity: vi.fn() } }))
// The member's profile id; their auth user id differs, as it may (BUGS.md, pattern A).
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'auth-me' } } }) }))

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
    store.apply('ch-1', state(), true)
    store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-2', activity: state({ channel_id: 'ch-2' }) } })
    expect(store.byChannel['ch-2']).toBeUndefined()
    store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1', activity: state({ channel_id: 'other', revision: 2, playing: false }) } })
    expect(store.current?.playing).toBe(true)
  })

  it('takes from a peer the playback of the item it holds, and nothing else', () => {
    const store = useActivitiesStore()
    const peer = (activity: unknown) => store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1', activity } })

    // No run held: a peer cannot start one.
    peer(state({ host_id: 'me' }))
    expect(store.current).toBeNull()

    store.apply('ch-1', state(), true)
    peer(state({ revision: 2, playing: false, position_ms: 5000, position_at: 2000, host_id: 'me', controls: 'host' }))
    // The held revision stays the database's.
    expect(store.current).toMatchObject({ revision: 1, playing: false, position_ms: 5000, host_id: 'p1', controls: 'everyone' })
    expect(store.playingHere).toBe(false)

    // A later run naming this member as host plays at once; it comes from the database alone.
    peer(state({ host_id: 'me', started_at: '2026-10-14T12:00:00Z', source: 'url', item: { url: 'https://attacker.test/x.mp4' } }))
    expect(store.current).toMatchObject({ host_id: 'p1', started_at: '2026-10-14T10:00:00Z' })
    expect(store.playingHere).toBe(false)

    // Another item or queue waits for the database's state of that revision.
    peer(state({ revision: 3, item: { video_id: 'other' } }))
    peer(state({ revision: 3, queue: [{ item: { video_id: 'next' } }] }))
    expect(store.current).toMatchObject({ revision: 1, item: { video_id: 'dQw4w9WgXcQ' }, queue: [] })
    expect(store.apply('ch-1', state({ revision: 3, item: { video_id: 'other' } }), true)).toBe(true)
  })

  it('a peer cannot freeze the run, and its numbers are checked', () => {
    const store = useActivitiesStore()
    const peer = (activity: unknown, userId = 'p2') =>
      store.receivePeer({ userId, message: { type: 'activity', channelId: 'ch-1', activity } })
    store.apply('ch-1', state({ revision: 5 }), true)

    // A huge revision moves the playback once, and the database's next state still applies.
    peer(state({ revision: 1e15, playing: false, position_at: 2000 }))
    expect(store.current).toMatchObject({ revision: 5, playing: false })
    expect(store.apply('ch-1', state({ revision: 6, playing: true, position_at: 3000 }), true)).toBe(true)
    // Peer states at or below one already taken are stale.
    peer(state({ revision: 9, playing: false, position_at: 4000 }))
    expect(store.current?.playing).toBe(true)

    store.apply('ch-1', state({ revision: 7, playing: true, position_at: 5000, started_at: '2026-10-14T13:00:00Z' }), true)
    peer(state({ revision: 8, position_ms: Number.NaN, started_at: '2026-10-14T13:00:00Z' }))
    peer(state({ revision: 8, position_ms: -5, started_at: '2026-10-14T13:00:00Z' }))
    expect(store.current?.position_at).toBe(5000)
    peer(state({ revision: 8, rate: 50, position_at: 6000, started_at: '2026-10-14T13:00:00Z' }))
    expect(store.current).toMatchObject({ position_at: 6000, rate: 1 })
  })

  it('a host-only run takes playback from its host alone', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state({ controls: 'host' }), true)
    store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1', activity: state({ controls: 'host', revision: 2, playing: false, position_at: 2000 }) } })
    expect(store.current?.playing).toBe(true)
    store.receivePeer({ userId: 'p1', message: { type: 'activity', channelId: 'ch-1', activity: state({ controls: 'host', revision: 2, playing: false, position_at: 2000 }) } })
    expect(store.current?.playing).toBe(false)
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

  it('plays a run this member starts after hiding one whose end it never applied', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state(), true)
    store.join()
    store.hide('ch-1', true)
    // The sidebar refresh drops the ended run without apply.
    store.byChannel = { 'ch-1': null }
    store.apply('ch-1', state({ host_id: 'me', started_at: '2026-10-14T12:00:00Z' }), true)
    expect(store.playingHere).toBe(true)
  })
})

describe('consent', () => {
  it('knows its own run by profile id, not by auth user id', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state({ host_id: 'auth-me' }), true)
    expect(store.playingHere).toBe(false)
    store.apply('ch-1', state({ host_id: 'me', started_at: '2026-10-14T12:00:00Z' }), true)
    expect(store.playingHere).toBe(true)
  })

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
