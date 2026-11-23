import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/supabase', () => ({ supabase: { realtime: { isConnected: () => true } } }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p, getStoredInstance: () => null }))
const voice = { isConnected: true, effectiveChannelId: 'ch-1', currentChannelId: 'ch-1' }
vi.mock('@/stores/unifiedVoiceChannel', () => ({ useUnifiedVoiceChannelStore: () => voice }))
vi.mock('@/services/webrtcManager', () => ({ webrtcManager: { sendActivity: vi.fn() } }))
// The member's profile id; their auth user id differs, as it may (BUGS.md, pattern A).
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'auth-me' } } }) }))

const serverList = vi.hoisted(() => ({ rows: [] as unknown[] }))
// The row get_voice_activity answers.
const row = vi.hoisted(() => ({ activity: null as unknown, reads: 0 }))
vi.mock('@/services/activities/activityService', async (load) => ({
  ...(await load<typeof import('@/services/activities/activityService')>()),
  getServerActivities: async () => serverList.rows,
  getActivity: async () => {
    row.reads++
    return { activity: row.activity, server_now: Date.now() }
  },
}))

const { useActivitiesStore } = await import('@/stores/activities')

const state = (over: Record<string, unknown> = {}) => ({
  channel_id: 'ch-1', server_id: 's', source: 'youtube', item: { video_id: 'dQw4w9WgXcQ' }, queue: [],
  playing: true, position_ms: 0, position_at: 1000, rate: 1, controls: 'everyone', host_id: 'p1',
  revision: 1, started_at: '2026-10-14T10:00:00Z', ...over,
}) as any

// States carry position_at in database-clock ms; the clock reads 2000 here.
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(2000)
  row.activity = null
  row.reads = 0
})
afterEach(() => vi.useRealTimers())

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
    expect(store.current).toMatchObject({ revision: 2, playing: false, position_ms: 5000, host_id: 'p1', controls: 'everyone' })
    expect(store.playingHere).toBe(false)

    // A later run naming this member as host plays at once; it comes from the database alone.
    peer(state({ host_id: 'me', started_at: '2026-10-14T12:00:00Z', source: 'url', item: { url: 'https://attacker.test/x.mp4' } }))
    expect(store.current).toMatchObject({ host_id: 'p1', started_at: '2026-10-14T10:00:00Z' })
    expect(store.playingHere).toBe(false)

    // Another item or queue waits for the database's state of that revision.
    peer(state({ revision: 3, item: { video_id: 'other' } }))
    peer(state({ revision: 3, queue: [{ item: { video_id: 'next' } }] }))
    expect(store.current).toMatchObject({ revision: 2, item: { video_id: 'dQw4w9WgXcQ' }, queue: [] })
    expect(store.apply('ch-1', state({ revision: 3, item: { video_id: 'other' } }), true)).toBe(true)
  })

  it('a peer cannot freeze the run, and its numbers are checked', () => {
    const store = useActivitiesStore()
    const peer = (activity: unknown, userId = 'p2') =>
      store.receivePeer({ userId, message: { type: 'activity', channelId: 'ch-1', activity } })
    store.apply('ch-1', state({ revision: 5 }), true)

    // Past the database's revision by more than a few controls: ignored.
    peer(state({ revision: 1e15, playing: false, position_at: 2000 }))
    expect(store.current).toMatchObject({ revision: 5, playing: true })

    store.apply('ch-1', state({ revision: 7, playing: true, position_at: 5000, started_at: '2026-10-14T13:00:00Z' }), true)
    peer(state({ revision: 8, position_ms: Number.NaN, started_at: '2026-10-14T13:00:00Z' }))
    peer(state({ revision: 8, position_ms: -5, started_at: '2026-10-14T13:00:00Z' }))
    expect(store.current?.position_at).toBe(5000)
    peer(state({ revision: 8, rate: 50, position_at: 6000, started_at: '2026-10-14T13:00:00Z' }))
    expect(store.current).toMatchObject({ position_at: 6000, rate: 1 })
  })

  it('a peer\'s state carries its revision, which the database\'s next state orders against', () => {
    const store = useActivitiesStore()
    const peer = (activity: unknown) =>
      store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1', activity } })
    store.apply('ch-1', state({ revision: 5, position_at: 1000 }), true)

    // A seek another member made: the item's end asks for the next one at that revision.
    peer(state({ revision: 6, position_ms: 90_000, position_at: 2000 }))
    expect(store.current).toMatchObject({ revision: 6, position_ms: 90_000 })

    // A database answer read before that seek does not roll it back.
    expect(store.apply('ch-1', state({ revision: 5, position_at: 1500 }), true)).toBe(false)
    expect(store.current?.position_ms).toBe(90_000)

    // The database's later states apply.
    expect(store.apply('ch-1', state({ revision: 7, playing: false, position_at: 3000 }), true)).toBe(true)
    expect(store.current).toMatchObject({ revision: 7, playing: false })
  })

  it('a peer state the database does not reach in time gives way to the database\'s', async () => {
    const store = useActivitiesStore()
    const peer = (userId: string, activity: unknown) =>
      store.receivePeer({ userId, message: { type: 'activity', channelId: 'ch-1', activity } })
    store.apply('ch-1', state({ revision: 5 }), true)
    // One revision ahead, paused: no control made it.
    peer('p2', state({ revision: 6, playing: false, position_at: 2000 }))
    expect(store.current).toMatchObject({ revision: 6, playing: false })

    // The database still answers 5; the deadline has not passed, and 5 may be a late broadcast.
    expect(store.apply('ch-1', state({ revision: 5, position_at: 1000 }), true)).toBe(false)
    row.activity = state({ revision: 5, position_at: 1000 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(row.reads).toBe(1)
    expect(store.current).toMatchObject({ revision: 5, playing: true })

    // The refuted participant is not taken again in the run; another one is.
    peer('p2', state({ revision: 6, playing: false, position_at: 4000 }))
    expect(store.current).toMatchObject({ revision: 5, playing: true })
    peer('p3', state({ revision: 6, position_ms: 7000, position_at: 5000 }))
    expect(store.current).toMatchObject({ revision: 6, position_ms: 7000 })
  })

  it('a broadcast older than a peer\'s state does not step it back, and the database confirms it', async () => {
    const store = useActivitiesStore()
    const peer = (revision: number, position_ms: number) => store.receivePeer({ userId: 'p2', message: { type: 'activity',
      channelId: 'ch-1', activity: state({ revision, position_ms, position_at: 2000 + revision }) } })
    store.apply('ch-1', state({ revision: 5 }), true)
    // Two seeks a member made; the peer's states arrive before the broadcasts.
    peer(6, 10_000)
    peer(7, 20_000)
    expect(store.apply('ch-1', state({ revision: 6, position_ms: 10_000, position_at: 2006 }), true)).toBe(false)
    expect(store.current).toMatchObject({ revision: 7, position_ms: 20_000 })
    store.apply('ch-1', state({ revision: 7, position_ms: 20_000, position_at: 2007 }), true)

    await vi.advanceTimersByTimeAsync(5000)
    expect(row.reads).toBe(0)
    expect(store.current).toMatchObject({ revision: 7, position_ms: 20_000 })
  })

  it('a peer state the database reaches only by a read is kept', async () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state({ revision: 5 }), true)
    store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1',
      activity: state({ revision: 6, playing: false, position_at: 2000 }) } })
    row.activity = state({ revision: 6, playing: false, position_at: 2000 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(row.reads).toBe(1)
    expect(store.current).toMatchObject({ revision: 6, playing: false })
    store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1',
      activity: state({ revision: 7, playing: true, position_at: 2100 }) } })
    expect(store.current).toMatchObject({ revision: 7, playing: true })
  })

  it('a peer\'s position_at lies near the database clock', () => {
    const store = useActivitiesStore()
    const peer = (position_at: number) => store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1',
      activity: state({ revision: 6, position_ms: 0, position_at }) } })
    store.apply('ch-1', state({ revision: 5, position_ms: 4000 }), true)
    peer(2000 + 3_600_000)
    peer(2000 - 3_600_000)
    expect(store.current).toMatchObject({ revision: 5, position_ms: 4000 })
    peer(2000 + 5000)
    expect(store.current).toMatchObject({ revision: 6, position_ms: 0 })
  })

  it('bounds a peer by the database\'s revision of a run the server list seeded', async () => {
    const store = useActivitiesStore()
    const peer = (revision: number) => store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1',
      activity: state({ revision, playing: revision % 2 === 0, position_at: 1000 + revision }) } })
    serverList.rows = [state({ revision: 5 })]
    await store.refreshServer('s')
    expect(store.current?.revision).toBe(5)

    for (let r = 6; r <= 20; r++) peer(r)
    expect(store.current?.revision).toBe(8)
    row.activity = state({ revision: 6, playing: true, position_at: 1900 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(store.current).toMatchObject({ revision: 6, playing: true })
  })

  it('an answer equal to the held state still counts as the database\'s', () => {
    const store = useActivitiesStore()
    const peer = (revision: number) => store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1',
      activity: state({ revision, position_at: 1000 + revision }) } })
    store.apply('ch-1', state({ revision: 5 }), true)
    peer(6)
    // The database answers the peer's change: same revision and position.
    expect(store.apply('ch-1', state({ revision: 6, position_at: 1006 }), true)).toBe(false)
    peer(7)
    // An answer read before revision 6 reached the database does not roll it back.
    expect(store.apply('ch-1', state({ revision: 6, playing: false, position_at: 1500 }), true)).toBe(false)
    expect(store.current?.revision).toBe(7)
    // The peer counts past the database's 6, not its own 7.
    for (let r = 8; r <= 12; r++) peer(r)
    expect(store.current?.revision).toBe(9)
  })

  it('takes no peer state for a run the database never answered', () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state({ revision: 5 }), false)
    store.receivePeer({ userId: 'p2', message: { type: 'activity', channelId: 'ch-1', activity: state({ revision: 6, playing: false, position_at: 2000 }) } })
    expect(store.current).toMatchObject({ revision: 5, playing: true })
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

  it('a server list read before the call\'s run started does not end it', async () => {
    const store = useActivitiesStore()
    store.apply('ch-1', state(), true)
    store.join()
    // The sidebar's list of the server's activities, requested before the run started.
    serverList.rows = []
    await store.refreshServer('s')
    expect(store.current).not.toBeNull()
    expect(store.playingHere).toBe(true)
  })

  it('a server list ends the activity of a channel this client is not in', async () => {
    const store = useActivitiesStore()
    store.apply('ch-2', state({ channel_id: 'ch-2' }), true)
    serverList.rows = []
    await store.refreshServer('s')
    expect(store.byChannel['ch-2']).toBeNull()
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
