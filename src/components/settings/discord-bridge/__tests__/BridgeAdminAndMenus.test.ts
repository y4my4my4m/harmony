/**
 * BridgeHostingAdmin.vue (Admin → Instance), BridgeBotGuide.vue (My Bots → bridge bot)
 * and the "Copy channel ID" item of ChannelContextMenu.vue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BridgeHostingAdmin from '../BridgeHostingAdmin.vue'
import BridgeBotGuide from '../../BridgeBotGuide.vue'
import ChannelContextMenu from '@/components/ChannelContextMenu.vue'
import { iconStub, installBackend, makeI18n, missingKeys, rpcCalls } from './bridgeTestKit'

const { toast, permissions } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  permissions: { manage: false, invite: false },
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/composables/useServerPermissions', async () => {
  const { computed } = await import('vue')
  return {
    useServerPermissions: () => ({
      canManageChannels: computed(() => permissions.manage),
      canManageWebhooks: computed(() => false),
      hasCurrentUserPermission: () => permissions.invite,
      Permission: { CREATE_INVITE: 'CREATE_INVITE' },
    }),
  }
})

const routerLinkStub = {
  name: 'RouterLink',
  props: ['to'],
  template: '<a class="router-link" :data-to="JSON.stringify(to)"><slot /></a>',
}

beforeEach(() => {
  missingKeys.length = 0
  Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  expect(missingKeys).toEqual([])
})

describe('BridgeHostingAdmin', () => {
  function mountAdmin() {
    return mount(BridgeHostingAdmin, { global: { plugins: [makeI18n()], stubs: { Icon: iconStub } } })
  }

  it('loads the hosting settings and points at the bridge host service docs', async () => {
    installBackend({
      instance_config: [
        { config_key: 'discord_bridge_hosting_enabled', config_value: true },
        { config_key: 'discord_bridge_hosting_limit', config_value: 40 },
      ],
    })
    const w = mountAdmin()
    await flushPromises()
    expect(w.find('[role="switch"]').attributes('aria-checked')).toBe('true')
    expect((w.find('[data-testid="hosting-limit"]').element as HTMLInputElement).value).toBe('40')
    const note = w.find('[data-testid="hosting-note"]')
    expect(note.text()).toContain('BRIDGE_MODE=host')
    expect(note.find('a').attributes('href')).toBe(
      'https://github.com/y4my4my4m/harmony/blob/master/self-host/README.md#discord-bridge-hosting',
    )
    expect(w.find('[data-testid="hosting-save"]').attributes('disabled')).toBeDefined()
    expect(w.find('h4').text()).toBe('Let communities bring their own bot')
    expect(w.text()).toContain('Communities create their own Discord bot, with their own name and avatar, and paste its token; this instance runs it.')
  })

  it('defaults to off with a limit of 25', async () => {
    installBackend({ instance_config: [] })
    const w = mountAdmin()
    await flushPromises()
    expect(w.find('[role="switch"]').attributes('aria-checked')).toBe('false')
    expect((w.find('[data-testid="hosting-limit"]').element as HTMLInputElement).value).toBe('25')
  })

  it('saves the switch as it changes and the limit on its button', async () => {
    installBackend({ instance_config: [] }, () => true)
    const w = mountAdmin()
    await flushPromises()
    await w.find('[role="switch"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('batch_set_instance_config')).toEqual([
      { p_keys: ['discord_bridge_hosting_enabled'], p_values: [true] },
    ])
    expect(toast.success).toHaveBeenCalledWith('Bridge hosting settings saved')
    expect(w.find('[data-testid="hosting-save"]').attributes('disabled')).toBeDefined()

    await w.find('[data-testid="hosting-limit"]').setValue('10')
    await w.find('[data-testid="hosting-save"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('batch_set_instance_config')[1]).toEqual({ p_keys: ['discord_bridge_hosting_limit'], p_values: [10] })
    expect(w.find('[data-testid="hosting-save"]').text()).toBe('Save limit')
    expect(w.find('[data-testid="hosting-save"]').attributes('disabled')).toBeDefined()
  })

  it('refuses a negative limit', async () => {
    installBackend({ instance_config: [] })
    const w = mountAdmin()
    await flushPromises()
    await w.find('[data-testid="hosting-limit"]').setValue('-1')
    expect(w.text()).toContain('Enter a whole number, 0 or more.')
    expect(w.find('[data-testid="hosting-save"]').attributes('disabled')).toBeDefined()
  })

  it('reports a refused save and returns the switch to its position', async () => {
    installBackend({ instance_config: [] }, () => false)
    const w = mountAdmin()
    await flushPromises()
    await w.find('[role="switch"]').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the bridge hosting settings")
    expect(w.find('[role="switch"]').attributes('aria-checked')).toBe('false')
  })
})

describe('BridgeBotGuide', () => {
  function mountGuide(botId?: string) {
    return mount(BridgeBotGuide, {
      props: botId ? { botId } : {},
      global: { plugins: [makeI18n()], stubs: { RouterLink: routerLinkStub, Icon: iconStub } },
    })
  }

  it('links a v2 bridge bot to its server bridge settings', async () => {
    installBackend({ discord_bridges: [{ bot_id: 'bot-1', server_id: 's1', servers: { name: 'Town Hall' } }] })
    const w = mountGuide('bot-1')
    await flushPromises()
    expect(w.find('[data-testid="bridge-owner"]').text()).toContain('This bot is the Discord bridge of Town Hall.')
    expect(JSON.parse(w.find('.router-link').attributes('data-to')!)).toEqual({
      name: 'ServerSettings',
      params: { serverId: 's1' },
      query: { section: 'discord-bridge' },
    })
  })

  it('sends a hand-made bridge bot to Server Settings → Discord Bridge, with correct v1 intents', async () => {
    installBackend({ discord_bridges: [] })
    const w = mountGuide('bot-2')
    await flushPromises()
    expect(w.find('[data-testid="bridge-unmanaged"]').text()).toContain('Server Settings → Discord Bridge')
    const legacy = w.find('details')
    expect(legacy.text()).toContain('Message Content Intent is required')
    expect(legacy.text()).toContain('Server Members Intent only if the bridge syncs the member list')
    expect(legacy.text()).not.toMatch(/optional/i)
    await w.find('input').setValue('111111111111111111')
    expect(w.find('a.btn').attributes('href')).toContain('client_id=111111111111111111')
  })
})

describe('ChannelContextMenu — Copy channel ID', () => {
  const channel = { id: 'c-123', name: 'general', type: 0, category: null, order: 0 }

  function mountMenu() {
    return mount(ChannelContextMenu, {
      props: { isVisible: true, position: { x: 10, y: 10 }, channel },
      global: { plugins: [makeI18n()] },
    })
  }

  it('offers the item to every member and copies the id', async () => {
    permissions.manage = false
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = mountMenu()
    const item = w.find('[data-testid="copy-channel-id"]')
    expect(item.text()).toBe('Copy channel ID')
    await item.trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('c-123')
    expect(toast.success).toHaveBeenCalledWith('Channel ID copied')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('reports a clipboard failure', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    const w = mountMenu()
    await w.find('[data-testid="copy-channel-id"]').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the channel ID")
  })

  it('keeps the management items for channel managers', () => {
    permissions.manage = true
    const w = mountMenu()
    expect(w.text()).toContain('Copy channel ID')
    expect(w.text()).toContain('Edit channel')
    permissions.manage = false
  })
})
