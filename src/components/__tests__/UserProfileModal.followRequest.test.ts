/**
 * UserProfileModal.vue follow button against a pending request: the request is read from
 * the follows row on every open, so a reopened card still reads "Cancel request", and
 * clicking it withdraws the request rather than following again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const { store, relationships, profileRow } = vi.hoisted(() => ({
  store: {
    blockedUsers: new Set<string>(),
    mutedUsers: new Set<string>(),
    followsLoaded: true,
    isFollowing: (_id: string) => false,
    isBlocked: (_id: string) => false,
    isMuted: (_id: string) => false,
    followUser: vi.fn(),
    unfollowUser: vi.fn(),
    loadFollowedUsers: vi.fn(),
    loadBlockingData: vi.fn(),
  },
  relationships: vi.fn(),
  profileRow: { current: { message_count: 0, voice_minutes: 0, manually_approves_followers: true } as Record<string, unknown> },
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
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => store }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: null, servers: [] }),
}))
vi.mock('@/services/InteractionService', () => ({
  interactionService: { getUserRelationships: relationships },
}))
vi.mock('@/services/core/CoreProfileService', () => ({
  coreProfileService: { getUserStats: vi.fn(async () => null) },
}))
vi.mock('@/services/RoleService', () => ({
  roleService: { getUserRoles: vi.fn(async () => []), hasPermission: vi.fn(async () => false) },
  Permission: {},
}))
vi.mock('@/services/activityPubService', () => ({ activityPubService: {} }))
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
    useUserData: () => ({
      getUser: none,
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

const TARGET = { id: 'target', username: 'locky', display_name: 'Locky', is_local: true }

function profilesQuery() {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    maybeSingle: async () => ({ data: profileRow.current, error: null }),
    single: async () => ({ data: profileRow.current, error: null }),
    then: (resolve: any) => resolve({ data: [], error: null }),
  }
  return chain
}

const open = (user: Record<string, unknown> = TARGET) =>
  mount(UserProfileModal, {
    props: { show: true, user: user as any },
    global: { directives: { 'click-outside': {} } },
  })

const followButton = (wrapper: ReturnType<typeof mount>) =>
  wrapper.get('[data-testid="profile-modal-follow-btn"]')

beforeEach(() => {
  vi.clearAllMocks()
  ;(supabase.from as any).mockImplementation(() => profilesQuery())
  profileRow.current = { message_count: 0, voice_minutes: 0, manually_approves_followers: true }
})

describe('UserProfileModal follow request', () => {
  it('reads a pending request on open and withdraws it on click', async () => {
    relationships.mockResolvedValue({ target: { followRequestPending: true } })
    store.unfollowUser.mockResolvedValue({ following: false, pending: false })

    const wrapper = open()
    await flushPromises()

    expect(relationships).toHaveBeenCalledWith(['target'])
    expect(followButton(wrapper).text()).toContain('activitypub.cancelFollowRequest')

    await followButton(wrapper).trigger('click')
    await flushPromises()

    expect(store.unfollowUser).toHaveBeenCalledWith('target')
    expect(store.followUser).not.toHaveBeenCalled()
    expect(followButton(wrapper).text()).toContain('activitypub.follow')
  })

  it('still shows the request after the card is closed and reopened', async () => {
    relationships.mockResolvedValue({})
    store.followUser.mockResolvedValue({ following: false, pending: true })

    const wrapper = open()
    await flushPromises()
    expect(followButton(wrapper).text()).toContain('activitypub.follow')

    await followButton(wrapper).trigger('click')
    await flushPromises()
    expect(store.followUser).toHaveBeenCalledWith('target')
    expect(followButton(wrapper).text()).toContain('activitypub.cancelFollowRequest')

    relationships.mockResolvedValue({ target: { followRequestPending: true } })
    await wrapper.setProps({ show: false })
    await flushPromises()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(relationships).toHaveBeenCalledTimes(2)
    expect(followButton(wrapper).text()).toContain('activitypub.cancelFollowRequest')
  })

  it('a fresh card for a locked account shows the lock and the stored request', async () => {
    relationships.mockResolvedValue({ target: { followRequestPending: true } })

    const wrapper = open({ ...TARGET })
    await flushPromises()

    expect(wrapper.find('[data-testid="profile-modal-locked-badge"]').exists()).toBe(true)
    expect(followButton(wrapper).text()).toContain('activitypub.cancelFollowRequest')
  })

  it('shows no lock for an account without approval', async () => {
    relationships.mockResolvedValue({})
    profileRow.current = { message_count: 0, voice_minutes: 0, manually_approves_followers: false }

    const wrapper = open()
    await flushPromises()

    expect(wrapper.find('[data-testid="profile-modal-locked-badge"]').exists()).toBe(false)
  })
})
