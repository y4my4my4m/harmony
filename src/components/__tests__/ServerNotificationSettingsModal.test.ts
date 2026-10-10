/**
 * Server notification settings modal: renders the member's state, and each control sends
 * one patch through the settings RPCs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/router', () => ({ default: { push: vi.fn() } }))
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: { connect: vi.fn(), on: vi.fn().mockReturnValue(() => {}), send: vi.fn(), disconnect: vi.fn() },
}))

import { supabase } from '@/supabase'
import ServerNotificationSettingsModal from '../ServerNotificationSettingsModal.vue'
import { useServerNotificationSettingsStore } from '@/stores/useServerNotificationSettings'
import { useServerChannelStore } from '@/stores/useServerChannel'
import type { Server } from '@/types'

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

const state = (overrides: Record<string, unknown> = {}) => ({
  server_id: 's1',
  muted: false,
  muted_until: null,
  level: null,
  server_default: 'mentions',
  suppress_everyone: false,
  suppress_roles: false,
  push_notifications: true,
  overrides: [{ channel_id: null, category_id: 'k1', level: 'none', muted: false, muted_until: null }],
  channels: [
    { id: 'c1', name: 'general', type: 0, category_id: 'k1', position: 0 },
    { id: 'c2', name: 'memes', type: 0, category_id: null, position: 1 },
  ],
  categories: [{ id: 'k1', name: 'Text', position: 0 }],
  ...overrides,
})

let wrapper: VueWrapper

async function open() {
  rpc.mockResolvedValue({ data: state(), error: null })
  useServerNotificationSettingsStore().openModal('s1')
  await flushPromises()
  rpc.mockClear()
}

const lastChanges = () => rpc.mock.calls.at(-1)

beforeEach(async () => {
  setActivePinia(createPinia())
  rpc.mockReset()
  useServerChannelStore().servers = [{ id: 's1', name: 'Book Club' } as Server]
  wrapper = mount(ServerNotificationSettingsModal, {
    attachTo: document.body,
    global: { stubs: { Teleport: true, Icon: true, LoadingSpinner: true } },
  })
  await open()
})

afterEach(() => wrapper.unmount())

describe('ServerNotificationSettingsModal', () => {
  it('shows the server default as the level of a member who set none', () => {
    const checked = wrapper.findAll<HTMLInputElement>('input[name="ns-server-level"]').filter(i => i.element.checked)
    expect(checked.map(i => i.attributes('value'))).toEqual(['mentions'])
    expect(wrapper.find('[data-testid="ns-level-reset"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="ns-override-row"]').map(r => r.attributes('data-target-id'))).toEqual(['k1'])
  })

  it('sets the server level', async () => {
    await wrapper.get('[data-testid="ns-level-all"]').trigger('change')
    expect(lastChanges()).toEqual(['update_server_notification_settings', { p_server_id: 's1', p_changes: { level: 'all' } }])
  })

  it('mutes for the chosen duration', async () => {
    const before = Date.now()
    await wrapper.get('[data-testid="ns-mute-duration"]').setValue('h1')
    await wrapper.get('[data-testid="ns-mute-toggle"]').trigger('click')
    const [name, args] = lastChanges()!
    expect(name).toBe('update_server_notification_settings')
    expect(args.p_changes.muted).toBe(true)
    const until = Date.parse(args.p_changes.muted_until)
    expect(until - before).toBeGreaterThanOrEqual(60 * 60_000 - 1000)
    expect(until - before).toBeLessThanOrEqual(60 * 60_000 + 5000)
  })

  it('writes the suppress and push toggles', async () => {
    await wrapper.get('[data-testid="ns-suppress-everyone"]').trigger('click')
    expect(lastChanges()?.[1].p_changes).toEqual({ suppress_everyone: true })
    await wrapper.get('[data-testid="ns-push"]').trigger('click')
    expect(lastChanges()?.[1].p_changes).toEqual({ push_notifications: false })
  })

  it('adds a channel from the picker and sets its level', async () => {
    const picker = wrapper.get<HTMLSelectElement>('[data-testid="ns-override-picker"]')
    const values = picker.findAll('option').map(o => o.attributes('value'))
    expect(values).toEqual(['', 'channel:c1', 'channel:c2'])

    picker.element.value = 'channel:c2'
    await picker.trigger('change')
    const row = wrapper.findAll('[data-testid="ns-override-row"]').find(r => r.attributes('data-target-id') === 'c2')!
    expect(row).toBeTruthy()
    expect(rpc).not.toHaveBeenCalled()

    await row.get('[data-testid="ns-override-all"]').trigger('change')
    expect(lastChanges()).toEqual(['update_channel_notification_override', { p_channel_id: 'c2', p_changes: { level: 'all' } }])
  })

  it('mutes and removes an override', async () => {
    const row = wrapper.get('[data-testid="ns-override-row"]')
    const mute = row.get<HTMLInputElement>('[data-testid="ns-override-mute"]')
    mute.element.checked = true
    await mute.trigger('change')
    expect(lastChanges()).toEqual(['update_category_notification_override', { p_category_id: 'k1', p_changes: { muted: true } }])

    await row.get('[data-testid="ns-override-remove"]').trigger('click')
    expect(lastChanges()).toEqual([
      'update_category_notification_override',
      { p_category_id: 'k1', p_changes: { level: null, muted: false } },
    ])
  })

  it('closes from Done', async () => {
    await wrapper.get('[data-testid="ns-done"]').trigger('click')
    expect(useServerNotificationSettingsStore().modalServerId).toBeNull()
  })
})
