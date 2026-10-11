/**
 * FollowersView.vue for keyboard and screen readers: Followers/Following/Requests are a
 * tablist controlling one tabpanel, follow requests are answered from buttons named
 * with the requester, and answering the last one hands focus to the Requests tab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const { api, interactions, polite } = vi.hoisted(() => ({
  api: {
    getFollowers: vi.fn(async () => []),
    getFollowing: vi.fn(async () => []),
    getFollowRequests: vi.fn(),
    getFollowRequestsCount: vi.fn(async () => 1),
  },
  interactions: {
    removeFollower: vi.fn(),
    acceptFollowRequest: vi.fn(async () => undefined),
    rejectFollowRequest: vi.fn(async () => undefined),
  },
  polite: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }))
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => ({ polite, assertive: vi.fn(), announce: vi.fn() }) }))
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

enableAutoUnmount(afterEach)

const FAN = { id: 'fan', username: 'fan', display_name: ':wave: Fan', is_local: true, handle: '@fan' }

function mountView(view: 'followers' | 'requests') {
  return mount(FollowersView, {
    props: { view, userProfile: { followers_count: 2, following_count: 3 } },
    global: { mocks: { $t: (key: string) => key }, stubs: { 'router-link': true } },
    attachTo: document.body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getFollowRequests.mockResolvedValue([FAN])
  ;(supabase.from as any).mockImplementation(() => {
    const chain: any = { select: () => chain, eq: () => chain, single: async () => ({ data: null, error: null }) }
    return chain
  })
})

describe('FollowersView tabs and requests', () => {
  it('exposes the three lists as a tablist controlling one tabpanel', async () => {
    const wrapper = mountView('followers')
    await flushPromises()
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map((tab) => tab.attributes('id'))).toEqual(['follow-tab-followers', 'follow-tab-following', 'follow-tab-requests'])
    expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1'])
    const panel = wrapper.get('[role="tabpanel"]')
    expect(tabs[0].attributes('aria-controls')).toBe(panel.attributes('id'))
    expect(panel.attributes('aria-labelledby')).toBe('follow-tab-followers')

    await tabs[2].trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe('follow-tab-requests')
  })

  it('names the request buttons with the requester and hands focus on after the last answer', async () => {
    const wrapper = mountView('requests')
    await flushPromises()
    const accept = wrapper.get('[data-testid="follow-request-accept"]')
    const decline = wrapper.get('[data-testid="follow-request-reject"]')
    expect(accept.attributes('aria-label')).toBe('today.social.acceptLabel:{"name":"Fan"}')
    expect(decline.attributes('aria-label')).toBe('today.social.declineLabel:{"name":"Fan"}')

    ;(accept.element as HTMLElement).focus()
    await accept.trigger('click')
    await flushPromises()
    expect(interactions.acceptFollowRequest).toHaveBeenCalledWith('fan')
    expect(wrapper.find('[data-testid="follow-request-accept"]').exists()).toBe(false)
    expect(document.activeElement?.id).toBe('follow-tab-requests')
    expect(polite).toHaveBeenCalledWith('empty.requests.title')
  })
})
