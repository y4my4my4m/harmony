/**
 * UserProfileModal.vue figures against the profiles row read: one read per open, a placeholder
 * until a figure is known and its value from then on, the remembered row on reopen, and no
 * figure of a previous account after a switch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const { reads, refreshRemoteProfile } = vi.hoisted(() => ({
  reads: [] as { columns: string; id: string; resolve: (row: Record<string, unknown> | null) => void }[],
  refreshRemoteProfile: vi.fn(async (): Promise<unknown> => null),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ path: '/social/home', params: {} }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: () => ({
    blockedUsers: new Set<string>(),
    mutedUsers: new Set<string>(),
    followsLoaded: true,
    isFollowing: () => false,
    isBlocked: () => false,
    isMuted: () => false,
    loadFollowedUsers: vi.fn(),
    loadBlockingData: vi.fn(),
  }),
}))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: null, servers: [] }),
}))
vi.mock('@/stores/useRolePicker', () => ({ useRolePickerStore: () => ({ openModal: vi.fn() }) }))
vi.mock('@/stores/useServerRoles', () => ({ useServerRolesStore: () => ({ rolesByServer: new Map() }) }))
vi.mock('@/services/InteractionService', () => ({
  interactionService: { getUserRelationships: vi.fn(async () => ({})) },
}))
vi.mock('@/services/RoleService', () => ({
  roleService: { getUserRoles: vi.fn(async () => []), hasPermission: vi.fn(async () => false) },
  Permission: {},
}))
vi.mock('@/services/activityPubService', () => ({ activityPubService: { refreshRemoteProfile } }))
vi.mock('@/composables/useLayoutState', async () => {
  const { ref } = await import('vue')
  return { useLayoutState: () => ({ closeMobileSidebars: vi.fn(), isMobile: ref(false) }) }
})
vi.mock('@/composables/useMovedAccount', async () => {
  const { ref } = await import('vue')
  return { useMovedAccount: () => ({ movedTo: ref(null), isMoved: ref(false) }) }
})
vi.mock('@/composables/useUserData', async () => {
  const { ref } = await import('vue')
  const none = () => ref(null)
  return {
    DEFAULT_USER_COLOR: 'var(--text-primary)',
    useUserData: () => ({
      getUser: none,
      getUserProfile: none,
      getUserStatusText: () => ref('Offline'),
      getUserDisplayName: none,
      getUserAvatarUrl: none,
      getUserColor: none,
      getUserBannerUrl: none,
      getUserCustomStatus: none,
      subscribeToProfilePresence: vi.fn(async () => 'ctx'),
      unsubscribeFromProfilePresence: vi.fn(async () => {}),
      getPresenceAwareStatus: () => ref('offline'),
      getCurrentUser: ref({ id: 'me' }),
    }),
  }
})

async function stub(name: string, slot = false) {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name,
      props: ['show'],
      setup: (props, { slots }) => () =>
        slot ? (props.show ? h('div', slots.default?.()) : null) : h('span'),
    }),
  }
}
vi.mock('@/components/common/BaseModal.vue', () => stub('BaseModal', true))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/BannerImage.vue', () => stub('BannerImage'))
vi.mock('@/components/common/SupporterBadge.vue', () => stub('SupporterBadge'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))
vi.mock('@/components/moderation/KickBanModal.vue', () => stub('KickBanModal'))
vi.mock('@/components/messages/BridgeSourceBadge.vue', () => stub('BridgeSourceBadge'))
vi.mock('@/components/activitypub/MovedAccountNotice.vue', () => stub('MovedAccountNotice'))

import { supabase } from '@/supabase'
import UserProfileModal from '../UserProfileModal.vue'

const PLACEHOLDER = '–'
const FIGURES = [
  'profile-stat-posts',
  'profile-stat-following',
  'profile-stat-followers',
  'profile-activity-messages',
  'profile-activity-voice',
]

/** profiles reads stay pending until the test resolves them. */
function profilesQuery() {
  let columns = ''
  let id = ''
  const chain: any = {
    select: (c: string) => { columns = c; return chain },
    eq: (_col: string, value: string) => { id = value; return chain },
    in: () => chain,
    maybeSingle: () => new Promise((resolve) => {
      reads.push({ columns, id, resolve: (row) => resolve({ data: row, error: null }) })
    }),
    then: (resolve: any) => resolve({ data: [], error: null }),
  }
  return chain
}

const cardReads = (id: string) => reads.filter(r => r.id === id && r.columns.includes('message_count'))

const figures = (wrapper: VueWrapper) =>
  FIGURES.map(id => wrapper.find(`[data-testid="${id}"]`).text())

const open = (user: Record<string, unknown>) =>
  mount(UserProfileModal, {
    props: { show: true, user: user as any },
    global: { directives: { 'click-outside': {} } },
  })

const localRow = (n: number) => ({
  is_local: true,
  created_at: '2026-11-01T00:00:00Z',
  posts_count: n,
  following_count: n + 1,
  followers_count: n + 2,
  message_count: n + 3,
  voice_minutes: 95,
  manually_approves_followers: false,
})

beforeEach(() => {
  vi.clearAllMocks()
  reads.length = 0
  ;(supabase.from as any).mockImplementation(() => profilesQuery())
  // The remote instance probe.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UserProfileModal profiles row', () => {
  it('reads the row once and shows the placeholder, then the values', async () => {
    const wrapper = open({ id: 'local-1', username: 'ada', is_local: true })
    await flushPromises()

    expect(cardReads('local-1')).toHaveLength(1)
    expect(figures(wrapper)).toEqual(Array(5).fill(PLACEHOLDER))
    expect(wrapper.text()).toContain('Posts')
    expect(wrapper.text()).not.toContain('Roles')

    cardReads('local-1')[0].resolve(localRow(7))
    await flushPromises()

    expect(figures(wrapper)).toEqual(['7', '8', '9', '10', '1h 35m'])
    expect(cardReads('local-1')).toHaveLength(1)
  })

  it('a reopened card shows the row read before at once and reads it once more', async () => {
    const wrapper = open({ id: 'local-2', username: 'bea', is_local: true })
    await flushPromises()
    cardReads('local-2')[0].resolve(localRow(1))
    await flushPromises()

    await wrapper.setProps({ show: false })
    await flushPromises()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(cardReads('local-2')).toHaveLength(2)
    expect(figures(wrapper)).toEqual(['1', '2', '3', '4', '1h 35m'])

    cardReads('local-2')[1].resolve(localRow(2))
    await flushPromises()
    expect(figures(wrapper)).toEqual(['2', '3', '4', '5', '1h 35m'])
  })

  it('drops a row that lands after the card switched to another account', async () => {
    const wrapper = open({ id: 'local-3', username: 'cy', is_local: true })
    await flushPromises()
    await wrapper.setProps({ user: { id: 'local-4', username: 'di', is_local: true } as any })
    await flushPromises()

    cardReads('local-3')[0].resolve(localRow(30))
    await flushPromises()
    expect(figures(wrapper)).toEqual(Array(5).fill(PLACEHOLDER))

    cardReads('local-4')[0].resolve(localRow(40))
    await flushPromises()
    expect(figures(wrapper)).toEqual(['40', '41', '42', '43', '1h 35m'])
  })

  it('a remote account shows the placeholder for Posts, then its origin total', async () => {
    const remote = { id: 'remote-1', username: 'ann', is_local: false, domain: 'remote.example' }
    const wrapper = open(remote)
    await flushPromises()

    const postsTile = () => wrapper.findAll('.activity-card').find(c => c.text().includes('Posts'))!
    expect(postsTile().find('.activity-value').text()).toBe(PLACEHOLDER)
    expect(refreshRemoteProfile).not.toHaveBeenCalled()

    cardReads('remote-1')[0].resolve({
      is_local: false,
      posts_count: 2,
      remote_posts_count: 120,
      remote_following_count: 10,
      remote_followers_count: 50,
      remote_counts_fetched_at: '2026-11-01T00:00:00Z',
    })
    await flushPromises()

    expect(postsTile().find('.activity-value').text()).toBe('120')
    expect(wrapper.find('[data-testid="profile-stat-followers"]').text()).toBe('50')
    expect(refreshRemoteProfile).toHaveBeenCalledTimes(1)
    expect(refreshRemoteProfile).toHaveBeenCalledWith('ann@remote.example')
    expect(cardReads('remote-1')).toHaveLength(1)
  })
})
