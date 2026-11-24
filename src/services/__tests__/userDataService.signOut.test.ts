import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Sign-out ends this tab's presence (presence_offline). No heartbeat or status publish follows
// it, and one already in flight is answered before presence_offline is sent.

const ME = 'aaaaaaaa-0000-4000-8000-000000000001'

const db = vi.hoisted(() => {
  const calls: string[] = []
  let hold: { fn: string; release: () => void } | null = null
  let holdNext: string | null = null
  return {
    calls,
    holdNext: (fn: string) => { holdNext = fn },
    release: () => { hold?.release(); hold = null },
    rpc: vi.fn((fn: string) => {
      calls.push(fn)
      if (holdNext === fn) {
        holdNext = null
        return new Promise((resolve) => {
          hold = { fn, release: () => resolve({ data: null, error: null }) }
        })
      }
      return Promise.resolve({ data: null, error: null })
    }),
  }
})

vi.mock('@/supabase', () => {
  const q: any = {
    select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
    single: async () => ({ data: { id: ME, username: 'me', status: 1 }, error: null }),
    maybeSingle: async () => ({ data: { id: ME, username: 'me', status: 1 }, error: null }),
    then: (resolve: any) => resolve({ data: [{ id: ME, username: 'me', status: 1 }], error: null }),
    update: () => ({ eq: async () => ({ error: null }) }),
  }
  return {
    SUPABASE_URL: 'http://db.test',
    SUPABASE_ANON_KEY: 'anon',
    supabase: {
      rpc: db.rpc,
      from: () => q,
      channel: () => {
        const ch: any = { on: () => ch, subscribe: () => ch, unsubscribe: async () => 'ok' }
        return ch
      },
      removeChannel: async () => 'ok',
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'jwt' } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
    },
  }
})
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { on: () => () => {} } }))
vi.mock('@/services/ActivityTracker', () => ({ activityTracker: new EventTarget() }))
vi.mock('@/services/unifiedEmojiService', () => ({ loadEmojiData: vi.fn(), isLoaded: { value: true } }))
vi.mock('@/utils/clientDeviceId', () => ({ getClientDeviceId: () => 'tab-1' }))
vi.mock('@/services/realtimeMemberToken', () => ({ currentRealtimeToken: () => 'member-1', onMemberToken: () => () => {} }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { userDataService } from '@/services/userDataService'
import { UserStatus } from '@/types'

const HEARTBEAT_MS = 60_000
const after = (fn: string) => db.calls.slice(db.calls.lastIndexOf(fn) + 1)

beforeEach(async () => {
  vi.useFakeTimers()
  await userDataService.cleanup()
  db.calls.length = 0
  await userDataService.initialize(ME, 'me')
})

afterEach(async () => {
  db.release()
  await userDataService.cleanup()
  vi.useRealTimers()
})

describe('sign-out presence', () => {
  it('sends no heartbeat after presence_offline', async () => {
    await userDataService.goOffline()
    expect(db.calls).toContain('presence_offline')

    await vi.advanceTimersByTimeAsync(3 * HEARTBEAT_MS)

    expect(after('presence_offline')).not.toContain('presence_heartbeat')
  })

  it('publishes no status change after presence_offline', async () => {
    await userDataService.goOffline()
    await userDataService.updateCurrentUserStatus(UserStatus.Away, false)

    expect(after('presence_offline')).not.toContain('presence_heartbeat')
  })

  it('answers a heartbeat in flight before presence_offline is sent', async () => {
    db.holdNext('presence_heartbeat')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(db.calls.at(-1)).toBe('presence_heartbeat')

    const offline = userDataService.goOffline()
    await vi.advanceTimersByTimeAsync(0)
    expect(db.calls).not.toContain('presence_offline')

    db.release()
    await offline
    expect(db.calls.at(-1)).toBe('presence_offline')
  })

  it('heartbeats again after the next sign-in', async () => {
    await userDataService.goOffline()
    await userDataService.cleanup()
    db.calls.length = 0

    await userDataService.initialize(ME, 'me')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)

    expect(db.calls.filter((fn) => fn === 'presence_heartbeat').length).toBeGreaterThanOrEqual(2)
  })
})
