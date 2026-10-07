/** BridgeAdminSection.vue: Admin → Instance → Discord bridge. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BridgeAdminSection from '../BridgeAdminSection.vue'
import { iconStub, installBackend, makeI18n, missingKeys } from './bridgeTestKit'

vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

beforeEach(() => {
  missingKeys.length = 0
})

describe('BridgeAdminSection', () => {
  it('is one Discord bridge section: the instance bot first, then communities\' own bots', async () => {
    installBackend({ instance_config: [] }, (name) =>
      name === 'discord_bridge_instance_bot_status'
        ? { enabled: false, configured: false, linked_count: 0, limit: 100, presence: false }
        : null,
    )
    const w = mount(BridgeAdminSection, { global: { plugins: [makeI18n()], stubs: { Icon: iconStub } } })
    await flushPromises()

    expect(w.find('h3').text()).toBe('Discord bridge')
    expect(w.findAll('h4').map((h) => h.text())).toEqual([
      "This instance's Discord bot",
      'Let communities bring their own bot',
    ])
    const sections = w.findAll('[data-testid^="bridge-"]').map((s) => s.attributes('data-testid'))
    expect(sections).toEqual(['bridge-admin-section', 'bridge-instance-bot-admin', 'bridge-hosting-admin'])
    expect(missingKeys).toEqual([])
  })
})
