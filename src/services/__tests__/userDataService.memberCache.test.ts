import { describe, it, expect, vi, beforeEach } from 'vitest'

// The profile cache beside a large server: members held by a context never push out the
// profiles a view shows, the least recently read profile goes first, and members the
// directory answered are cached without a request.

const db = vi.hoisted(() => ({ profileRequests: [] as string[][], rpc: [] as string[] }))

vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => true }))
vi.mock('@/supabase', () => {
  const profiles = () => {
    let ids: string[] = []
    const q: any = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      in: (_column: string, values: string[]) => { ids = values; return q },
      then: (resolve: any) => {
        db.profileRequests.push(ids)
        return resolve({ data: ids.map(id => ({ id, username: `user-${id.slice(-4)}`, is_local: true })), error: null })
      },
    }
    return q
  }
  const channel = () => {
    const c: any = { on: () => c, subscribe: () => c, unsubscribe: async () => 'ok' }
    return c
  }
  return {
    SUPABASE_URL: 'http://db.test',
    SUPABASE_ANON_KEY: 'anon',
    supabase: {
      from: profiles,
      rpc: vi.fn(async (name: string) => { db.rpc.push(name); return { data: [], error: null } }),
      channel,
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
import { UserStatus } from '@/types'
import type { DirectoryMember } from '@/services/memberDirectoryService'

const uuid = (n: number, kind = 'a') => `${kind.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
const member = (n: number, over: Partial<DirectoryMember> = {}): DirectoryMember => ({
  id: uuid(n), username: `member${n}`, display_name: `Member ${n}`, is_local: true,
  online: false, presence_status: 0, is_mobile: false, role_ids: [], ...over,
})
const SERVER = 'server-1'

beforeEach(async () => {
  await userDataService.cleanup()
  db.profileRequests.length = 0
  db.rpc.length = 0
})

describe('members answered by the directory', () => {
  it('are cached with their presence, with no profile or presence request', async () => {
    await userDataService.primeMembers([
      member(1, { online: true, presence_status: 2, is_mobile: true }),
      member(2, { status: 1 }),
      member(3, { status: 3 }),
    ])
    await userDataService.subscribeToContext(SERVER, 'server', [uuid(1), uuid(2), uuid(3)], { preloaded: true, partial: true })

    expect(db.profileRequests).toEqual([])
    expect(db.rpc).not.toContain('get_presence')
    expect(userDataService.getUser(uuid(1))).toMatchObject({ displayName: 'Member 1', isOnline: true, isMobile: true, status: UserStatus.Away })
    // Absent with a stored Online reads Offline; a stored Busy stays, gated by isOnline.
    expect(userDataService.getUser(uuid(2))).toMatchObject({ isOnline: false, status: UserStatus.Offline })
    expect(userDataService.getUser(uuid(3))).toMatchObject({ isOnline: false, status: UserStatus.Busy })
    expect(userDataService.getUsersInContext(SERVER).map(u => u.username)).toEqual(['member1', 'member2', 'member3'])
  })

  it('a preloaded subscribe to an existing context replaces its members', async () => {
    await userDataService.primeMembers([member(1), member(2), member(3)])
    await userDataService.subscribeToContext(SERVER, 'server', [uuid(1), uuid(2)], { preloaded: true, partial: true })
    await userDataService.subscribeToContext(SERVER, 'server', [uuid(2), uuid(3)], { preloaded: true })
    expect(userDataService.getUsersInContext(SERVER).map(u => u.username)).toEqual(['member2', 'member3'])
    expect(userDataService.getContextMemberCount(SERVER)).toBe(2)
  })
})

describe('profile cache eviction', () => {
  it('keeps an author outside a context of more than 1000 members', async () => {
    const members = Array.from({ length: 1200 }, (_, i) => member(i + 1))
    await userDataService.subscribeToContext(SERVER, 'server', members.map(m => m.id), { preloaded: true })
    await userDataService.primeMembers(members)

    const author = uuid(1, 'b')
    await userDataService.ensureUsersLoaded([author])
    expect(userDataService.getUser(author)).not.toBeNull()

    // More loads follow: the author stays, and so does every member.
    await userDataService.ensureUsersLoaded([uuid(2, 'b'), uuid(3, 'b')])
    expect(userDataService.getUser(author)).not.toBeNull()
    expect(userDataService.getUsersInContext(SERVER)).toHaveLength(1200)
  })

  it('past 1000 profiles outside every context, drops the least recently read', async () => {
    const first = Array.from({ length: 1000 }, (_, i) => uuid(i + 1, 'c'))
    await userDataService.ensureUsersLoaded(first)
    // Read again: on screen.
    expect(userDataService.getUser(first[0])).not.toBeNull()

    await userDataService.ensureUsersLoaded([uuid(1, 'd'), uuid(2, 'd')])
    expect(userDataService.getUser(first[0]), 'read since: kept').not.toBeNull()
    expect(userDataService.getUser(uuid(1, 'd')), 'loaded last: kept').not.toBeNull()
    expect(userDataService.getUser(first[1]), 'oldest unread: dropped').toBeNull()
    expect(userDataService.getUser(first[2])).toBeNull()
    expect(userDataService.getStats().totalUsers).toBe(1000)
  })

  it('members a windowed context let go of become evictable', async () => {
    const members = Array.from({ length: 600 }, (_, i) => member(i + 1))
    await userDataService.primeMembers(members)
    await userDataService.subscribeToContext(SERVER, 'server', members.map(m => m.id), { preloaded: true, partial: true })
    userDataService.setContextMembers(SERVER, members.slice(500).map(m => m.id))

    await userDataService.ensureUsersLoaded(Array.from({ length: 900 }, (_, i) => uuid(i + 1, 'e')))
    // 500 released members and 900 others compete for 1000 places; the 100 held stay.
    expect(userDataService.getUsersInContext(SERVER)).toHaveLength(100)
    expect(userDataService.getStats().totalUsers).toBe(1100)
  })
})

describe('a partial context', () => {
  it('announces a join without adding the member or reading its profile', async () => {
    await userDataService.primeMembers([member(1)])
    await userDataService.subscribeToContext(SERVER, 'server', [uuid(1)], { preloaded: true, partial: true })
    const heard: string[] = []
    userDataService.addEventListener('context-updated', (e) => heard.push((e as CustomEvent).detail.type))

    await (userDataService as any).handleServerMemberJoin(SERVER, { new: { user_id: uuid(9) } })

    expect(heard).toContain('member-join')
    expect(userDataService.getContextMemberCount(SERVER)).toBe(1)
    expect(db.profileRequests).toEqual([])
  })

  it('a whole context adds the member', async () => {
    await userDataService.primeMembers([member(1)])
    await userDataService.subscribeToContext(SERVER, 'server', [uuid(1)], { preloaded: true })
    await (userDataService as any).handleServerMemberJoin(SERVER, { new: { user_id: uuid(9) } })
    expect(userDataService.getContextMemberCount(SERVER)).toBe(2)
    expect(db.profileRequests).toEqual([[uuid(9)]])
  })
})

describe('this client\'s own presence', () => {
  it('announces each change of status, not the first publish or a heartbeat', async () => {
    const SELF = uuid(1, 'f')
    ;(userDataService as any).currentUserId = SELF
    ;(userDataService as any).users.set(SELF, { id: SELF, username: 'me', status: UserStatus.Online, isOnline: true, isMobile: false })
    const heard: unknown[] = []
    userDataService.addEventListener('presence-event', (e) => heard.push((e as CustomEvent).detail))

    await (userDataService as any).publishPresence()
    await (userDataService as any).publishPresence()
    expect(heard).toEqual([])

    ;(userDataService as any).users.get(SELF).status = UserStatus.Invisible
    await (userDataService as any).publishPresence()
    expect(heard).toEqual([{ userId: SELF, self: true }])
    await (userDataService as any).publishPresence()
    expect(heard).toHaveLength(1)
    expect(db.rpc.filter(name => name === 'presence_heartbeat')).toHaveLength(4)
  })
})

describe('presence broadcasts', () => {
  it('are announced for a member the cache does not hold', () => {
    const heard: Array<{ userId: string; online: boolean }> = []
    userDataService.addEventListener('presence-event', (e) => heard.push((e as CustomEvent).detail))
    ;(userDataService as any).applyPresenceUpdate({ user_id: uuid(77), online: true, status: 1 })
    expect(heard).toEqual([{ userId: uuid(77), online: true }])
    expect(userDataService.getUser(uuid(77))).toBeNull()
  })
})
