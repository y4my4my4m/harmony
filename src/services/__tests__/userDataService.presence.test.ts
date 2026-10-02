import { describe, it, expect, vi, beforeEach } from 'vitest'

// Presence comes from the database: this tab heartbeats its own presence, reads
// others through get_presence, and applies presence:update events. No Realtime
// Presence topic is opened, and profiles.status takes manual choices only.

const { ME, FRIEND, STRANGER } = vi.hoisted(() => ({
  ME: 'aaaaaaaa-0000-4000-8000-000000000001',
  FRIEND: 'bbbbbbbb-0000-4000-8000-000000000002',
  STRANGER: 'cccccccc-0000-4000-8000-000000000003',
}))

const db = vi.hoisted(() => {
  const calls: Array<{ fn: string; args: any }> = []
  const updates: any[] = []
  const channels: Array<{ topic: string; handlers: Record<string, (p: any) => void> }> = []
  let presenceRows: any[] = []
  return {
    calls, updates, channels,
    setRows: (rows: any[]) => { presenceRows = rows },
    rpc: vi.fn(async (fn: string, args: any) => {
      calls.push({ fn, args })
      if (fn === 'get_presence') {
        return { data: presenceRows.filter((r) => (args.p_profile_ids as string[]).includes(r.profile_id)), error: null }
      }
      return { data: null, error: null }
    }),
  }
})
const userEvents = vi.hoisted(() => ({ handlers: {} as Record<string, (p: any) => void> }))

vi.mock('@/supabase', () => {
  const profilesQuery = (rows: any[]) => {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      single: async () => ({ data: rows[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: rows, error: null }),
      update: (patch: any) => { db.updates.push(patch); return { eq: async () => ({ error: null }) } },
    }
    return q
  }
  return {
    SUPABASE_URL: 'http://db.test',
    SUPABASE_ANON_KEY: 'anon',
    supabase: {
      rpc: db.rpc,
      from: () => profilesQuery([
        { id: ME, username: 'me', status: 1 },
        { id: FRIEND, username: 'friend', status: 1 },
        { id: STRANGER, username: 'stranger', status: 1 },
      ]),
      channel: (topic: string) => {
        const record = { topic, handlers: {} as Record<string, (p: any) => void> }
        db.channels.push(record)
        const ch: any = {
          on: (_t: string, f: { event: string }, cb: (p: any) => void) => { record.handlers[f.event] = cb; return ch },
          subscribe: () => ch,
          unsubscribe: async () => 'ok',
        }
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
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: {
    on: (type: string, cb: (p: any) => void) => { userEvents.handlers[type] = cb; return () => { delete userEvents.handlers[type] } },
  },
}))
vi.mock('@/services/RealtimeApiService', () => ({
  realtimeApiService: { startHeartbeat: vi.fn(), updateStatus: vi.fn(), goOffline: vi.fn(async () => {}), cleanup: vi.fn() },
}))
vi.mock('@/services/ActivityTracker', () => ({ activityTracker: new EventTarget() }))
vi.mock('@/services/unifiedEmojiService', () => ({ loadEmojiData: vi.fn(), isLoaded: { value: true } }))
vi.mock('@/utils/clientDeviceId', () => ({ getClientDeviceId: () => 'tab-1' }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { userDataService } from '@/services/userDataService'
import { UserStatus } from '@/types'

const user = (id: string) => userDataService.getUser(id)

beforeEach(async () => {
  await userDataService.cleanup()
  db.calls.length = 0
  db.updates.length = 0
  db.channels.length = 0
  db.setRows([])
  await userDataService.initialize(ME, 'me')
})

describe('presence', () => {
  it('heartbeats this tab and opens no Realtime Presence topic', () => {
    expect(db.calls).toContainEqual({
      fn: 'presence_heartbeat',
      args: { p_device_id: 'tab-1', p_status: UserStatus.Online, p_is_mobile: false },
    })
    expect(db.channels.map((c) => c.topic)).not.toContain('harmony-global-presence')
  })

  it('reads a context through get_presence: a returned profile is online, any other offline', async () => {
    db.setRows([{ profile_id: FRIEND, status: UserStatus.Busy, online: true, is_mobile: true }])
    await userDataService.subscribeToContext('server-1', 'server', [FRIEND, STRANGER])
    expect(db.calls.find((c) => c.fn === 'get_presence' && c.args.p_profile_ids.includes(FRIEND))).toBeTruthy()
    expect(user(FRIEND)).toMatchObject({ isOnline: true, status: UserStatus.Busy, isMobile: true })
    expect(user(STRANGER)?.isOnline).toBe(false)
    expect(db.channels.map((c) => c.topic)).toContain('server-presence:server-1')
  })

  it('applies presence:update from the server topic and the user channel', async () => {
    await userDataService.subscribeToContext('server-1', 'server', [FRIEND, STRANGER])
    const server = db.channels.find((c) => c.topic === 'server-presence:server-1')!
    server.handlers.presence_event({ payload: { type: 'presence:update', user_id: FRIEND, online: true, status: UserStatus.Away, is_mobile: false } })
    expect(user(FRIEND)).toMatchObject({ isOnline: true, status: UserStatus.Away })
    userEvents.handlers['presence:update']({ type: 'presence:update', user_id: FRIEND, online: false, status: 0 })
    expect(user(FRIEND)?.isOnline).toBe(false)
  })

  it('a manual Invisible goes to profiles.status as Online; an automatic change writes nothing there', async () => {
    db.calls.length = 0
    await userDataService.updateCurrentUserStatus(UserStatus.Invisible, true)
    expect(db.updates).toEqual([{ status: UserStatus.Online }])
    expect(db.calls).toContainEqual(expect.objectContaining({ fn: 'presence_heartbeat', args: expect.objectContaining({ p_status: UserStatus.Invisible }) }))

    db.updates.length = 0
    await userDataService.updateCurrentUserStatus(UserStatus.Away, false)
    expect(db.updates).toEqual([])
    await userDataService.updateCurrentUserStatus(UserStatus.Offline, false)
    expect(db.calls.at(-1)).toEqual({ fn: 'presence_offline', args: { p_device_id: 'tab-1' } })
  })
})
