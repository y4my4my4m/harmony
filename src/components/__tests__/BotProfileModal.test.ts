/**
 * BotProfileModal.vue: the preview until the profile loads, its sections, and which server
 * actions a viewer gets.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { BotProfile } from '@/services/botProfileService'

const { api, perms, push, confirmMock, toast, servers } = vi.hoisted(() => ({
  api: {
    fetchBotProfile: vi.fn(),
    fetchBotInstallTargets: vi.fn(),
    addBotToServer: vi.fn(),
    isBotInstalled: vi.fn(),
    removeBotFromServer: vi.fn(),
  },
  perms: { manage: false, owner: false },
  push: vi.fn(),
  confirmMock: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  servers: [] as Array<{ id: string }>,
}))

// Partial: the import graph reaches @/i18n (uploadValidation), which calls createI18n.
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: confirmMock }) }))
vi.mock('@/composables/useOpenServer', () => ({ useOpenServer: () => vi.fn() }))
vi.mock('@/composables/useServerPermissions', async () => {
  const { computed } = await import('vue')
  return {
    useServerPermissions: () => ({
      canManageServer: computed(() => perms.manage),
      isCurrentUserServerOwner: computed(() => perms.owner),
    }),
  }
})
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'auth-1' } } }) }))
vi.mock('@/stores/server', () => ({ useServerStore: () => ({ joinServer: vi.fn() }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ servers, fetchServersForUser: vi.fn() }),
}))
vi.mock('@/services/botProfileService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/botProfileService')>()
  return { ...actual, ...api }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/ServerIcon.vue', () => stub('ServerIcon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))
vi.mock('@/components/ActivityIcon.vue', () => stub('ActivityIcon'))
vi.mock('@/components/common/BaseModal.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'BaseModal',
      props: { show: Boolean },
      setup: (props, { slots }) => () => (props.show ? h('div', { class: 'modal' }, slots.default?.()) : null),
    }),
  }
})

import BotProfileModal from '../BotProfileModal.vue'

function profile(over: Partial<BotProfile> = {}): BotProfile {
  return {
    id: 'bot-1',
    username: 'helper',
    displayName: 'Helper',
    avatarUrl: '/default_avatar.webp',
    botType: 'bot',
    status: 'online',
    activityType: 'playing',
    statusText: 'Playing: chess',
    sortKey: 'helper',
    bannerUrl: null,
    bio: 'Answers questions.',
    isVerified: true,
    isPublic: true,
    website: { href: 'https://helper.test/', label: 'helper.test' },
    createdAt: '2026-01-01T00:00:00Z',
    supportServer: { id: 'srv-support', name: 'Helper HQ', icon: null },
    commands: Array.from({ length: 7 }, (_, i) => ({ name: `cmd${i + 1}`, description: i === 0 ? null : `Command ${i + 1}` })),
    ...over,
  }
}

function mountCard(props: Record<string, unknown> = {}) {
  return mount(BotProfileModal, {
    props: { show: true, botId: 'bot-1', preview: { username: 'helper', displayName: 'Helper (cached)' }, ...props },
  })
}

describe('BotProfileModal', () => {
  beforeEach(() => {
    Object.values(api).forEach(fn => fn.mockReset())
    push.mockReset()
    confirmMock.mockReset()
    toast.success.mockReset()
    toast.error.mockReset()
    perms.manage = false
    perms.owner = false
    servers.length = 0
    api.isBotInstalled.mockResolvedValue(true)
  })

  it('shows the preview, then the profile with its sections', async () => {
    let resolve!: (p: BotProfile) => void
    api.fetchBotProfile.mockReturnValue(new Promise(r => { resolve = r }))
    const wrapper = mountCard()

    expect(wrapper.find('.display-name-text').text()).toBe('Helper (cached)')
    expect(wrapper.find('.bot-tag').text()).toBe('bots.badge.bot')

    resolve(profile())
    await flushPromises()

    expect(api.fetchBotProfile).toHaveBeenCalledWith('bot-1')
    expect(wrapper.find('.display-name-text').text()).toBe('Helper')
    expect(wrapper.find('.username').text()).toBe('@helper')
    expect(wrapper.find('.verified-badge').exists()).toBe(true)
    expect(wrapper.find('.about-text').text()).toBe('Answers questions.')
    expect(wrapper.find('.custom-status-text').text()).toBe('Playing: chess')
    const link = wrapper.find('a.link-row')
    expect(link.attributes('href')).toBe('https://helper.test/')
    expect(link.attributes('rel')).toContain('noopener')
    expect(wrapper.text()).toContain('Helper HQ')
    expect(wrapper.text()).toContain('bots.profile.joinServer')
  })

  it('collapses a long command list', async () => {
    api.fetchBotProfile.mockResolvedValue(profile())
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.findAll('.command-row')).toHaveLength(5)
    expect(wrapper.find('.command-row .command-description').text()).toBe('bots.noDescription')
    await wrapper.find('.toggle-commands').trigger('click')
    expect(wrapper.findAll('.command-row')).toHaveLength(7)
    expect(wrapper.find('.toggle-commands').text()).toBe('bots.profile.showFewerCommands')
  })

  it('keeps the preview and says so when the profile cannot be read', async () => {
    api.fetchBotProfile.mockResolvedValue(null)
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.find('.display-name-text').text()).toBe('Helper (cached)')
    expect(wrapper.find('.load-failed').exists()).toBe(true)
    expect(wrapper.find('.profile-actions').exists()).toBe(false)
  })

  it('offers no server actions outside a server and Add only for a public bot', async () => {
    perms.manage = true
    perms.owner = true
    api.fetchBotProfile.mockResolvedValue(profile({ isPublic: false }))
    const wrapper = mountCard({ serverId: null })
    await flushPromises()

    expect(api.isBotInstalled).not.toHaveBeenCalled()
    expect(wrapper.find('.profile-actions').exists()).toBe(false)
  })

  it('gives a manager settings and the owner removal', async () => {
    api.fetchBotProfile.mockResolvedValue(profile({ isPublic: false }))
    perms.manage = true
    const manager = mountCard({ serverId: 'srv-1' })
    await flushPromises()
    expect(api.isBotInstalled).toHaveBeenCalledWith('bot-1', 'srv-1')
    expect(manager.text()).toContain('bots.profile.settings')
    expect(manager.text()).not.toContain('bots.profile.remove')

    await manager.findAll('.secondary-action-btn')[0].trigger('click')
    expect(push).toHaveBeenCalledWith({
      name: 'ServerSettings',
      params: { serverId: 'srv-1' },
      query: { section: 'advanced' },
      hash: '#server-bots',
    })
    expect(manager.emitted('close')).toHaveLength(1)

    perms.owner = true
    const owner = mountCard({ serverId: 'srv-1' })
    await flushPromises()
    expect(owner.find('.secondary-action-btn.danger').text()).toBe('bots.profile.remove')
  })

  it('hides server actions when the bot is not installed there', async () => {
    perms.manage = true
    perms.owner = true
    api.isBotInstalled.mockResolvedValue(false)
    api.fetchBotProfile.mockResolvedValue(profile({ isPublic: false }))
    const wrapper = mountCard({ serverId: 'srv-1' })
    await flushPromises()

    expect(wrapper.find('.profile-actions').exists()).toBe(false)
  })

  it('removes after confirmation and closes', async () => {
    perms.owner = true
    api.fetchBotProfile.mockResolvedValue(profile({ isPublic: false }))
    api.removeBotFromServer.mockResolvedValue(undefined)
    const wrapper = mountCard({ serverId: 'srv-1' })
    await flushPromises()

    confirmMock.mockResolvedValueOnce(false)
    await wrapper.find('.secondary-action-btn.danger').trigger('click')
    await flushPromises()
    expect(api.removeBotFromServer).not.toHaveBeenCalled()

    confirmMock.mockResolvedValueOnce(true)
    await wrapper.find('.secondary-action-btn.danger').trigger('click')
    await flushPromises()
    expect(api.removeBotFromServer).toHaveBeenCalledWith('bot-1', 'srv-1')
    expect(toast.success).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('adds a public bot to a server the viewer owns', async () => {
    api.fetchBotProfile.mockResolvedValue(profile({ botType: 'bridge' }))
    api.fetchBotInstallTargets.mockResolvedValue({
      servers: [{ id: 'srv-a', name: 'A', icon: null }, { id: 'srv-b', name: 'B', icon: null }],
      installed: new Set(['srv-a']),
    })
    api.addBotToServer.mockResolvedValue(undefined)
    const wrapper = mountCard()
    await flushPromises()

    await wrapper.find('.primary-action-btn').trigger('click')
    await flushPromises()
    const items = wrapper.findAll('.server-picker-item')
    expect(items).toHaveLength(2)
    expect(items[0].attributes('disabled')).toBeDefined()

    await items[1].trigger('click')
    await flushPromises()
    expect(api.addBotToServer).toHaveBeenCalledWith('bot-1', 'bridge', 'srv-b')
    expect(wrapper.findAll('.server-picker-item')[1].attributes('disabled')).toBeDefined()
  })

  it('opens the support server for a member', async () => {
    servers.push({ id: 'srv-support' })
    api.fetchBotProfile.mockResolvedValue(profile())
    const wrapper = mountCard()
    await flushPromises()

    expect(wrapper.find('.btn-inline').text()).toBe('bots.profile.openServer')
  })

  it('refetches for another bot', async () => {
    api.fetchBotProfile.mockResolvedValue(profile())
    const wrapper = mountCard()
    await flushPromises()
    await wrapper.setProps({ botId: 'bot-2' })
    await flushPromises()

    expect(api.fetchBotProfile).toHaveBeenLastCalledWith('bot-2')
    expect(api.fetchBotProfile).toHaveBeenCalledTimes(2)
  })
})
