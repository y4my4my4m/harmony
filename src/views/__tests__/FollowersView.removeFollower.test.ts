/**
 * FollowersView.vue "Remove follower": offered on the viewer's own followers list only,
 * confirmed first, then the follow is deleted and the row leaves the list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const { api, interactions, confirmMock, toast } = vi.hoisted(() => ({
  api: {
    getFollowers: vi.fn(),
    getFollowing: vi.fn(async () => []),
    getFollowRequests: vi.fn(async () => []),
    getFollowRequestsCount: vi.fn(async () => 0),
  },
  interactions: {
    removeFollower: vi.fn(),
    acceptFollowRequest: vi.fn(),
    rejectFollowRequest: vi.fn(),
  },
  confirmMock: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: confirmMock }) }))
vi.mock('@/services/activityPubService', () => ({ activityPubService: api }))
vi.mock('@/services/InteractionService', () => ({ interactionService: interactions }))
vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: () => ({ followedUsers: new Set(['x']), loadFollowedUsers: vi.fn() }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'me' } } }) }))
// The virtualizer measures a scroll element happy-dom does not lay out; every row is rendered.
vi.mock('@tanstack/vue-virtual', async () => {
  const { computed, unref } = await import('vue')
  return {
    useVirtualizer: (opts: any) => computed(() => {
      const count = unref(opts).count
      return {
        getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 100 })),
        getTotalSize: () => count * 100,
        measureElement: () => {},
      }
    }),
  }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, props: ['user'], render: () => h('span') }) }
}
vi.mock('@/components/activitypub/UserCard.vue', () => stub('UserCard'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/EmptyState.vue', () => stub('EmptyState'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))

import { supabase } from '@/supabase'
import FollowersView from '../FollowersView.vue'

const REMOTE = { id: 'remote-fan', username: 'fan', display_name: 'Fan', is_local: false, domain: 'remote.test', handle: '@fan@remote.test' }
const LOCAL = { id: 'local-fan', username: 'pal', display_name: 'Pal', is_local: true, handle: '@pal' }

function mountView(userId?: string) {
  return mount(FollowersView, {
    props: { view: 'followers', userId, userProfile: { followers_count: 2, following_count: 0 } },
    global: { mocks: { $t: (key: string) => key }, stubs: { 'router-link': true } },
  })
}

const removeButtons = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[data-testid="remove-follower-btn"]')

beforeEach(() => {
  vi.clearAllMocks()
  api.getFollowers.mockResolvedValue([REMOTE, LOCAL])
  ;(supabase.from as any).mockImplementation(() => {
    const chain: any = { select: () => chain, eq: () => chain, single: async () => ({ data: null, error: null }) }
    return chain
  })
})

describe('FollowersView remove follower', () => {
  it('is offered for each follower on the viewer\'s own list', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(removeButtons(wrapper)).toHaveLength(2)
  })

  it('is not offered on someone else\'s list', async () => {
    const wrapper = mountView('someone-else')
    await flushPromises()
    expect(removeButtons(wrapper)).toHaveLength(0)
  })

  it('removes a confirmed follower and drops the row', async () => {
    confirmMock.mockResolvedValue(true)
    interactions.removeFollower.mockResolvedValue(undefined)
    const wrapper = mountView()
    await flushPromises()

    await removeButtons(wrapper)[0].trigger('click')
    await flushPromises()

    expect(interactions.removeFollower).toHaveBeenCalledWith('remote-fan')
    expect(removeButtons(wrapper)).toHaveLength(1)
    expect(wrapper.findAll('.toggle-btn .count')[0].text()).toBe('1')
    expect(toast.success).toHaveBeenCalled()
  })

  it('does nothing when the confirmation is declined', async () => {
    confirmMock.mockResolvedValue(false)
    const wrapper = mountView()
    await flushPromises()

    await removeButtons(wrapper)[0].trigger('click')
    await flushPromises()

    expect(interactions.removeFollower).not.toHaveBeenCalled()
    expect(removeButtons(wrapper)).toHaveLength(2)
  })
})
