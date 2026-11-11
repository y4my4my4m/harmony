/**
 * UnifiedProfileCard with a server id: nickname as the name line, account name and @username
 * beneath, server pronouns. Without one: the account profile with account pronouns.
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
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: {} }),
}))
vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: () => ({ isFollowing: () => false, isMuted: () => false, isBlocked: () => false }),
}))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (k: string) => k }),
}))

import { setActivePinia, createPinia } from 'pinia'
import { userDataService } from '@/services/userDataService'
import UnifiedProfileCard from '../UnifiedProfileCard.vue'

const U = '11111111-1111-4111-8111-111111111111'
const S = 'server-S'
const user = { id: U, username: 'ally_acct', display_name: 'Account Name', status: 0 } as any

describe('UnifiedProfileCard server profile', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(userDataService as any).users.clear()
    ;(userDataService as any).memberServerFields.clear()
    ;(userDataService as any).users.set(U, {
      id: U, username: 'ally_acct', displayName: 'Account Name', avatarUrl: 'account.png', pronouns: 'she/her',
      status: 0, isOnline: false, isMobile: false, createdAt: '', lastSeen: '', lastHeartbeat: '',
      isLocal: true, lastCacheUpdate: '', source: 'database',
    })
    userDataService.setMemberServerProfile(S, U, { nickname: 'Ally', pronouns: 'they/them', bio: 'Server bio' })
  })

  const card = (props: Record<string, unknown> = {}) =>
    mount(UnifiedProfileCard, { props: { user, showActions: false, hasStats: false, ...props }, global: { stubs: { Avatar: true, Icon: true, SupporterBadge: true, RemoteInstanceBadge: true } } })

  it('shows the nickname, the account name, @username and server pronouns in a server', () => {
    const w = card({ serverId: S })
    expect(w.get('.user-name').text()).toBe('Ally')
    expect(w.get('[data-testid="card-account-name"]').text()).toBe('Account Name')
    expect(w.get('.user-handle').text()).toBe('@ally_acct')
    expect(w.get('[data-testid="card-pronouns"]').text()).toBe('they/them')
    expect(w.text()).toContain('Server bio')
  })

  it('shows the account name and account pronouns outside a server', () => {
    const w = card()
    expect(w.get('.user-name').text()).toBe('Account Name')
    expect(w.find('[data-testid="card-account-name"]').exists()).toBe(false)
    expect(w.get('[data-testid="card-pronouns"]').text()).toBe('she/her')
    expect(w.text()).not.toContain('Server bio')
  })

  it('shows an unsaved nickname from serverProfile', () => {
    const w = card({ serverId: S, serverProfile: { nickname: 'Drafty', pronouns: null } })
    expect(w.get('.user-name').text()).toBe('Drafty')
    expect(w.get('[data-testid="card-pronouns"]').text()).toBe('she/her')
  })

  it('shows the account name once the draft nickname is cleared, not the stored one', () => {
    const w = card({ serverId: S, serverProfile: { nickname: null } })
    expect(w.get('.user-name').text()).toBe('Account Name')
    expect(w.find('[data-testid="card-account-name"]').exists()).toBe(false)
  })
})
