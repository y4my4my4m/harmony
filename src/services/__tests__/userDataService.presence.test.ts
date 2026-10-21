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
  const channels: Array<{
    topic: string
    handlers: Record<string, (p: any) => void>
    /** The subscribe callback; realtime-js calls it again on each of its own rejoins. */
    status?: (status: string, err?: Error) => void
    removed: boolean
  }> = []
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
        const record: (typeof db.channels)[number] = { topic, handlers: {}, removed: false }
        db.channels.push(record)
        const ch: any = {
          on: (_t: string, f: { event: string }, cb: (p: any) => void) => { record.handlers[f.event] = cb; return ch },
          subscribe: (cb?: (status: string, err?: Error) => void) => { record.status = cb; return ch },
          unsubscribe: async () => 'ok',
          __record: record,
        }
        return ch
      },
      // realtime-js closes an unjoined channel inline.
      removeChannel: vi.fn(async (ch: any) => {
        ch.__record.removed = true
        ch.__record.status?.('CLOSED')
        return 'ok'
      }),
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

describe('server presence channel errors', () => {
  const REFUSAL = 'Unauthorized: You do not have permissions to read from this Channel topic: server-presence:server-1'
  const opened = () => db.channels.filter((c) => c.topic === 'server-presence:server-1')
  const fail = (message: string) => opened().at(-1)!.status!('CHANNEL_ERROR', new Error(message))

  it('stops on a refusal: a server the user is not a member of is not retried', async () => {
    vi.useFakeTimers()
    try {
      await userDataService.subscribeToContext('server-1', 'server', [FRIEND])
      fail(REFUSAL)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(opened()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes a refused channel, so realtime-js stops rejoining it, and ignores what it reports after', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await userDataService.subscribeToContext('server-1', 'server', [FRIEND])
      const refused = opened()[0]
      fail(REFUSAL)
      expect(refused.removed).toBe(true)

      refused.status!('CHANNEL_ERROR', new Error(REFUSAL))
      refused.status!('CHANNEL_ERROR', new Error('timeout'))
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(opened()).toHaveLength(1)
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('refused'))).toHaveLength(1)
      expect(error).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      error.mockRestore()
      vi.useRealTimers()
    }
  })

  it('opens the channel again when the user comes back to a refused server', async () => {
    vi.useFakeTimers()
    try {
      await userDataService.subscribeToContext('server-1', 'server', [FRIEND])
      await userDataService.subscribeToContext('server-1', 'server', [FRIEND])
      expect(opened()).toHaveLength(1)

      fail(REFUSAL)
      await userDataService.subscribeToContext('server-1', 'server', [FRIEND])
      expect(opened()).toHaveLength(2)
      expect(opened()[1].removed).toBe(false)

      // The new channel is live: its errors are retried.
      fail('timeout')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(opened()).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps one retry pending: realtime-js's own rejoin errors neither push it out nor count", async () => {
    vi.useFakeTimers()
    try {
      await userDataService.subscribeToContext('server-1', 'server', [FRIEND])
      fail('timeout')
      await vi.advanceTimersByTimeAsync(3_000)
      fail('timeout')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(opened()).toHaveLength(2)

      // Second app retry: 10 s, the first doubling.
      fail('timeout')
      await vi.advanceTimersByTimeAsync(9_999)
      expect(opened()).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(opened()).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rejoin by realtime-js cancels the pending retry, re-reads presence and starts the backoff over', async () => {
    vi.useFakeTimers()
    try {
      await userDataService.subscribeToContext('server-1', 'server', [FRIEND])
      fail('timeout')
      db.calls.length = 0
      opened()[0].status!('SUBSCRIBED')
      expect(db.calls.some((c) => c.fn === 'get_presence')).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(opened()).toHaveLength(1)

      fail('timeout')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(opened()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries any other error, 5 s doubling, and starts over once subscribed', async () => {
    vi.useFakeTimers()
    try {
      await userDataService.subscribeToContext('server-1', 'server', [FRIEND])
      fail('timeout')
      await vi.advanceTimersByTimeAsync(4_999)
      expect(opened()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(opened()).toHaveLength(2)
      fail('timeout')
      await vi.advanceTimersByTimeAsync(9_999)
      expect(opened()).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(opened()).toHaveLength(3)
      opened().at(-1)!.status!('SUBSCRIBED')
      fail('timeout')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(opened()).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('status expiry', () => {
  it('drops an expired status of any cached user and announces it, leaving live ones', () => {
    const users = (userDataService as any).users as Map<string, any>
    users.set(FRIEND, { ...(users.get(FRIEND) ?? { id: FRIEND }), customStatus: { text: 'OBS Studio', type: 'streaming', expiresAt: '2026-10-12T00:00:00.000Z' } })
    users.set(STRANGER, { ...(users.get(STRANGER) ?? { id: STRANGER }), customStatus: { text: 'lunch', expiresAt: '2026-10-12T01:00:00.000Z' } })
    const seen: string[] = []
    const onChange = (e: Event) => seen.push((e as CustomEvent).detail.userId)
    userDataService.addEventListener('custom-status-changed', onChange)

    userDataService.dropExpiredStatuses(Date.parse('2026-10-12T00:30:00.000Z'))

    userDataService.removeEventListener('custom-status-changed', onChange)
    expect(users.get(FRIEND).customStatus).toBeUndefined()
    expect(users.get(STRANGER).customStatus?.text).toBe('lunch')
    expect(seen).toEqual([FRIEND])
  })
})
