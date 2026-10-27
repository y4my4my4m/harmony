import { describe, it, expect, vi, beforeEach } from 'vitest'

// profiles.instance_role is 1.9.1. The native app signs in to instances of other releases: the
// profile select names the column only where /instance-info lists instance-staff-roles, since
// PostgREST answers 400 to a select naming a column the schema lacks.

const { REMOTE, LOCAL } = vi.hoisted(() => ({
  REMOTE: 'aaaaaaaa-0000-4000-8000-0000000000e1',
  LOCAL: 'bbbbbbbb-0000-4000-8000-000000000002',
}))

const db = vi.hoisted(() => ({
  selects: [] as string[],
  /** The instance's schema has profiles.instance_role. */
  hasColumn: true,
}))
const caps = vi.hoisted(() => ({ staffRoles: true }))

vi.mock('@/services/instanceCapabilities', () => ({
  hasCapability: (name: string) => name !== 'instance-staff-roles' || caps.staffRoles,
}))

vi.mock('@/supabase', () => {
  const rows = [
    { id: REMOTE, username: 'remote', domain: 'peer.test', is_local: false, instance_role: 'admin' },
    { id: LOCAL, username: 'local', is_local: true, is_admin: false, instance_role: null },
  ]
  const profiles = () => {
    let columns = ''
    const q: any = {
      select: (c: string) => { columns = c; db.selects.push(c); return q },
      eq: () => q, in: () => q, order: () => q, limit: () => q,
      then: (resolve: any) => {
        if (columns.includes('instance_role') && !db.hasColumn) {
          return resolve({ data: null, error: { code: '42703', message: 'column profiles.instance_role does not exist' } })
        }
        const keep = columns.split(',').map((c) => c.trim())
        return resolve({
          data: rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k)))),
          error: null,
        })
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
  db.selects.length = 0
})

describe('profile select and instance staff roles', () => {
  it('reads instance_role from an instance that lists instance-staff-roles', async () => {
    caps.staffRoles = true
    db.hasColumn = true
    await userDataService.fetchMultipleUserProfiles([REMOTE, LOCAL], true)
    expect(db.selects).toHaveLength(1)
    expect(db.selects[0]).toMatch(/\binstance_role\b/)
    expect(userDataService.getUser(REMOTE)).toMatchObject({ username: 'remote', instanceRole: 'admin' })
  })

  it('leaves instance_role out for an instance before 1.9.1, so its profiles load', async () => {
    caps.staffRoles = false
    db.hasColumn = false
    await userDataService.fetchMultipleUserProfiles([REMOTE, LOCAL], true)
    expect(db.selects).toHaveLength(1)
    expect(db.selects[0]).not.toMatch(/\binstance_role\b/)
    expect(userDataService.getUser(REMOTE)).toMatchObject({ username: 'remote', instanceRole: null })
    expect(userDataService.getUser(LOCAL)).toMatchObject({ username: 'local' })
  })

  it('names the column the older instance lacks only when told to: the stub refuses it (control)', async () => {
    caps.staffRoles = true
    db.hasColumn = false
    await userDataService.fetchMultipleUserProfiles([REMOTE, LOCAL], true)
    expect(userDataService.getUser(REMOTE)).toBeNull()
  })
})
