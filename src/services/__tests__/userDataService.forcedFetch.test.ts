import { describe, it, expect, vi, beforeEach } from 'vitest'

// fetchUserProfile(id, true) reads the row again even while the cached entry is fresh, and keeps
// the entry's presence fields. A refreshed remote profile and an edited own profile reach every
// <DisplayName> through it.

const { USER } = vi.hoisted(() => ({ USER: 'cccccccc-0000-4000-8000-0000000000c1' }))

const db = vi.hoisted(() => ({
  row: { id: '', username: 'mirror', domain: 'bird.test', is_local: false, display_name: 'Before' } as Record<string, unknown>,
  reads: 0,
}))

vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => true }))

vi.mock('@/supabase', () => {
  const profiles = () => {
    let columns = ''
    const q: any = {
      select: (c: string) => { columns = c; return q },
      eq: () => q, in: () => q, order: () => q, limit: () => q,
      then: (resolve: any) => {
        db.reads++
        const keep = columns.split(',').map((c) => c.trim())
        const row = { ...db.row, id: USER }
        return resolve({ data: [Object.fromEntries(Object.entries(row).filter(([k]) => keep.includes(k)))], error: null })
      },
    }
    return q
  }
  return {
    SUPABASE_URL: 'http://db.test',
    SUPABASE_ANON_KEY: 'anon',
    supabase: {
      from: profiles,
      rpc: vi.fn(async () => ({ data: null, error: null })),
      channel: () => ({ on: () => ({}), subscribe: () => ({}) }),
      removeChannel: vi.fn(async () => 'ok'),
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
    },
  }
})
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { on: () => () => {} } }))
vi.mock('@/services/RealtimeApiService', () => ({
  realtimeApiService: { startHeartbeat: vi.fn(), updateStatus: vi.fn(), goOffline: vi.fn(async () => {}), cleanup: vi.fn() },
}))
vi.mock('@/services/ActivityTracker', () => ({ activityTracker: new EventTarget() }))
vi.mock('@/services/unifiedEmojiService', () => ({ loadEmojiData: vi.fn(), isLoaded: { value: true } }))
vi.mock('@/utils/clientDeviceId', () => ({ getClientDeviceId: () => 'tab-1' }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { userDataService } from '@/services/userDataService'

beforeEach(async () => {
  await userDataService.cleanup()
  db.row.display_name = 'Before'
  db.reads = 0
})

describe('fetchUserProfile', () => {
  it('answers a fresh entry from the cache', async () => {
    expect((await userDataService.fetchUserProfile(USER))?.display_name).toBe('Before')
    db.row.display_name = 'After'

    expect((await userDataService.fetchUserProfile(USER))?.display_name).toBe('Before')
    expect(db.reads).toBe(1)
  })

  it('reads the row again when forced, while the entry is fresh', async () => {
    await userDataService.fetchUserProfile(USER)
    db.row.display_name = 'After'

    const forced = await userDataService.fetchUserProfile(USER, true)

    expect(forced?.display_name).toBe('After')
    expect(userDataService.getUserProfile(USER)?.display_name).toBe('After')
    expect(db.reads).toBe(2)
  })

  it('keeps presence fields across a forced read', async () => {
    await userDataService.fetchUserProfile(USER)
    const entry = (userDataService as any).users.get(USER)
    ;(userDataService as any).users.set(USER, { ...entry, isOnline: true, isMobile: true })

    await userDataService.fetchUserProfile(USER, true)

    const after = (userDataService as any).users.get(USER)
    expect(after.isOnline).toBe(true)
    expect(after.isMobile).toBe(true)
  })
})
