/**
 * The in-chat invite card reads its counts from get_invite_preview through getInviteInfo:
 * members always, online when the database answers the count.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { InviteInfo } from '@/services/inviteService'
import ServerInviteCard from '../ServerInviteCard.vue'

const { getInviteInfo } = vi.hoisted(() => ({ getInviteInfo: vi.fn() }))

vi.mock('@/services/inviteService', () => ({ getInviteInfo }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ warning: vi.fn(), error: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: null }) }))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ settings: { instanceName: 'Harmony' } }),
}))
vi.mock('@/composables/useInviteJoin', () => ({
  useInviteJoin: () => ({
    isJoining: ref(false),
    showRules: ref(false),
    serverRules: ref([]),
    pendingInstanceRules: ref([]),
    requestJoin: vi.fn(),
    confirmJoin: vi.fn(),
    openServer: vi.fn(),
  }),
}))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/invite/ServerRulesModal.vue', () => stub('ServerRulesModal'))
vi.mock('@/components/invite/InviteAcceptModal.vue', () => stub('InviteAcceptModal'))

function info(extra: Partial<InviteInfo> = {}): InviteInfo {
  return {
    code: 'ABCD1234',
    serverId: 'server-1',
    serverName: 'Lounge',
    description: null,
    icon: null,
    banner: null,
    rules: [],
    memberCount: 12,
    onlineCount: 3,
    expiresAt: null,
    isMember: false,
    ...extra,
  }
}

async function render(resolved: InviteInfo) {
  getInviteInfo.mockResolvedValue({ info: resolved })
  const wrapper = mount(ServerInviteCard, {
    props: { inviteCode: resolved.code, inviteUrl: `https://harmony.test/invite/${resolved.code}` },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  getInviteInfo.mockReset()
})

describe('ServerInviteCard counts', () => {
  it('shows the online count beside the member count', async () => {
    const wrapper = await render(info())
    expect(wrapper.find('.server-name').text()).toBe('Lounge')
    expect(wrapper.find('.online-count').text()).toBe('3 online')
    expect(wrapper.find('.member-count').text()).toContain('12 members')
  })

  it('shows zero online', async () => {
    const wrapper = await render(info({ onlineCount: 0 }))
    expect(wrapper.find('.online-count').text()).toBe('0 online')
  })

  it('shows no online count when the database answers none', async () => {
    const wrapper = await render(info({ onlineCount: null }))
    expect(wrapper.find('.online-count').exists()).toBe(false)
    expect(wrapper.find('.member-count').text()).toContain('12 members')
  })
})
