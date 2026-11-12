/**
 * DisplayName with a server id shows the member's nickname (member list rows, mention chips,
 * typing names and every other in-server name go through it); without one, the account name.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@/supabase', () => ({
  SUPABASE_URL: 'http://db.test',
  SUPABASE_ANON_KEY: 'anon',
  supabase: {
    from: () => {
      const q: any = { select: () => q, eq: () => q, in: () => q, single: async () => ({ data: null }), then: (r: any) => r({ data: [], error: null }) }
      return q
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
    channel: () => {
      const ch: any = { on: () => ch, subscribe: () => ch }
      return ch
    },
    removeChannel: vi.fn(async () => 'ok'),
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}))

import { setActivePinia, createPinia } from 'pinia'
import { userDataService } from '@/services/userDataService'
import DisplayName from '../DisplayName.vue'
import MemberIdentity from '../MemberIdentity.vue'

const U = '11111111-1111-4111-8111-111111111111'
const S = 'server-S'

describe('DisplayName with a server id', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(userDataService as any).users.clear()
    ;(userDataService as any).memberServerFields.clear()
    ;(userDataService as any).users.set(U, {
      id: U, username: 'ally_acct', displayName: 'Account Name', avatarUrl: 'account.png',
      status: 0, isOnline: false, isMobile: false, createdAt: '', lastSeen: '', lastHeartbeat: '',
      isLocal: true, lastCacheUpdate: '', source: 'database',
    })
    userDataService.setMemberServerProfile(S, U, { nickname: 'Ally' })
  })

  it('shows the nickname in the server', () => {
    const w = mount(DisplayName, { props: { userId: U, serverId: S } })
    expect(w.text()).toBe('Ally')
  })

  it('shows the account name with no server, or another server', () => {
    expect(mount(DisplayName, { props: { userId: U } }).text()).toBe('Account Name')
    expect(mount(DisplayName, { props: { userId: U, serverId: null } }).text()).toBe('Account Name')
    expect(mount(DisplayName, { props: { userId: U, serverId: 'other' } }).text()).toBe('Account Name')
  })

  it('follows a live nickname change', async () => {
    const w = mount(DisplayName, { props: { userId: U, serverId: S } })
    userDataService.setMemberServerProfile(S, U, { nickname: 'Al' })
    await w.vm.$nextTick()
    expect(w.text()).toBe('Al')
  })
})

describe('MemberIdentity', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(userDataService as any).users.clear()
    ;(userDataService as any).memberServerFields.clear()
    ;(userDataService as any).users.set(U, {
      id: U, username: 'ally_acct', displayName: 'Account Name', avatarUrl: 'account.png',
      status: 0, isOnline: false, isMobile: false, createdAt: '', lastSeen: '', lastHeartbeat: '',
      isLocal: true, lastCacheUpdate: '', source: 'database',
    })
  })

  it('shows account name, handle and nickname', () => {
    userDataService.setMemberServerProfile(S, U, { nickname: 'Ally' })
    const w = mount(MemberIdentity, { props: { userId: U, serverId: S } })
    expect(w.text()).toBe('Account Name (@ally_acct) (Ally)')
  })

  it('leaves the nickname off when the member has none', () => {
    const w = mount(MemberIdentity, { props: { userId: U, serverId: S } })
    expect(w.text()).toBe('Account Name (@ally_acct)')
  })
})
