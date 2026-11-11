/**
 * UnifiedProfileCard in a server context shows "Joined on Discord <date>" when the member has a
 * migration link there; the lookup is made once per server and member.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('@/supabase', () => ({
  SUPABASE_URL: 'http://db.test',
  SUPABASE_ANON_KEY: 'anon',
  supabase: {
    from: () => {
      const q: any = { select: () => q, eq: () => q, in: () => q, single: async () => ({ data: null }), then: (r: any) => r({ data: [], error: null }) }
      return q
    },
    rpc: (...args: unknown[]) => rpc(...args),
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
import UnifiedProfileCard from '../UnifiedProfileCard.vue'

const user = { id: 'u-joined', username: 'ally', display_name: 'Ally', status: 0, created_at: '2024-01-01T00:00:00Z' } as any

describe('UnifiedProfileCard Discord join date', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    rpc.mockReset()
  })

  it('shows the date next to the member-since stat and asks once per server and member', async () => {
    rpc.mockResolvedValue({ data: '2020-01-02T03:04:05Z', error: null })
    const first = mount(UnifiedProfileCard, { props: { user, serverId: 'srv-J' } })
    await flushPromises()
    expect(first.get('[data-testid="discord-joined"]').text()).toContain('2020')
    expect(first.get('[data-testid="discord-joined"]').text()).toContain('discordMigration.joinedOnDiscord')

    const second = mount(UnifiedProfileCard, { props: { user, serverId: 'srv-J' } })
    await flushPromises()
    expect(second.find('[data-testid="discord-joined"]').exists()).toBe(true)
    expect(rpc.mock.calls.filter(c => c[0] === 'discord_migration_member_joined_at')).toHaveLength(1)
  })

  it('shows nothing when there is no date, or outside a server', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    const none = mount(UnifiedProfileCard, { props: { user: { ...user, id: 'u-none' }, serverId: 'srv-J' } })
    await flushPromises()
    expect(none.find('[data-testid="discord-joined"]').exists()).toBe(false)

    rpc.mockClear()
    const outside = mount(UnifiedProfileCard, { props: { user: { ...user, id: 'u-out' } } })
    await flushPromises()
    expect(outside.find('[data-testid="discord-joined"]').exists()).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })
})
