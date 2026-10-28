/**
 * UserProfileModal.vue profile fields: a remote field's link whose text is a label, or names
 * another host than its href, carries the masked-link class, so opening it asks first
 * (services/outsideLinks). A link showing its own URL does not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

const REMOTE = {
  id: 'remote',
  username: 'ann',
  display_name: 'Ann',
  is_local: false,
  domain: 'remote.example',
  fields: [
    { name: 'Code', value: '<a href="https://evil.example/" rel="me">https://github.com/ann</a>' },
    { name: 'Blog', value: '<a href="https://evil.example/blog">my blog</a>' },
    { name: 'Site', value: '<a href="https://ann.example/" rel="me"><span>https://</span><span>ann.example</span></a>' },
  ],
}

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

const open = (user: Record<string, unknown> = REMOTE) =>
  mount(UserProfileModal, {
    props: { show: true, user: user as any },
    global: { directives: { 'click-outside': {} } },
  })

beforeEach(() => {
  vi.clearAllMocks()
  ;(supabase.from as any).mockImplementation(() => profilesQuery())
  relationships.mockResolvedValue({})
  // The remote instance probe.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UserProfileModal profile field links', () => {
  it('marks a label and a deceptive URL as masked, not the URL itself', async () => {
    const wrapper = open()
    await flushPromises()
    const links = wrapper.findAll('.field-value a')
    expect(links.map((a) => a.text())).toEqual(['https://github.com/ann', 'my blog', 'https://ann.example'])
    expect(links.map((a) => a.classes('masked-link'))).toEqual([true, true, false])
    expect(links.every((a) => a.attributes('target') === '_blank')).toBe(true)
  })
})
