import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ServerEncryptionSettings from '../ServerEncryptionSettings.vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    return message.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t, locale: { value: 'en' } }) }
})

const SERVER = 'srv-enc'

vi.mock('@/supabase', () => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: { encryption_mode: 'optional', force_key_setup: false, voice_encryption_mode: 'disabled' }, error: null }),
  }
  return {
    supabase: {
      from: () => query,
      rpc: async () => ({ data: { total: 4, with_keys: 2, percentage: 50 }, error: null }),
    },
  }
})
vi.mock('@/services/userDataService', () => ({ userDataService: { getCurrentUser: () => ({ id: 'owner' }) } }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ servers: [{ id: 'srv-enc', owner: 'owner' }] }),
}))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }) }))
vi.mock('@/components/common/Icon.vue', () => ({ default: { name: 'Icon', render: () => null } }))

enableAutoUnmount(afterEach)

async function mountSettings() {
  const wrapper = mount(ServerEncryptionSettings, {
    props: { serverId: SERVER },
    attachTo: document.body,
    global: { stubs: { 'i18n-t': { template: '<span><slot name="mode" /></span>' } } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('ServerEncryptionSettings encryption mode', () => {
  it('groups the mode radios under one name in a labelled radiogroup', async () => {
    const wrapper = await mountSettings()
    const group = wrapper.get('[data-testid="encryption-mode-group"]')

    expect(group.attributes('role')).toBe('radiogroup')
    expect(document.getElementById(group.attributes('aria-labelledby')!)?.textContent).toBe('Encryption mode')
    expect(document.getElementById(group.attributes('aria-describedby')!)?.textContent).toBe('Choose how encryption is enforced')

    const radios = group.findAll('input[type="radio"]')
    expect(radios).toHaveLength(3)
    const names = new Set(radios.map((r) => r.attributes('name')))
    expect(names.size).toBe(1)
    expect([...names][0]).toBeTruthy()

    const labels = radios.map((r) => document.querySelector(`label[for="${r.attributes('id')}"]`)?.textContent?.trim())
    expect(labels).toEqual(['Disabled', 'Optional', 'Required'])
    expect(radios.map((r) => (r.element as HTMLInputElement).checked)).toEqual([false, true, false])

    const required = radios[2]
    const described = required.attributes('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent?.trim())
    expect(described[0]).toContain('Every channel is encrypted')
    expect(described[1]).toContain("won't be able to send messages")
  })

  it('applies the mode side effects when a radio changes, as arrow keys do', async () => {
    const wrapper = await mountSettings()
    const radios = wrapper.findAll('[data-testid="encryption-mode-group"] input[type="radio"]')
    const forceKeySetup = () => wrapper.findAll('input[type="checkbox"]')[0].element as HTMLInputElement
    expect(forceKeySetup().checked).toBe(false)

    ;(radios[2].element as HTMLInputElement).checked = true
    await radios[2].trigger('change')

    expect((radios[2].element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.get('.status-title').text()).toBe('Encryption required')
    expect(forceKeySetup().checked).toBe(true)

    ;(radios[0].element as HTMLInputElement).checked = true
    await radios[0].trigger('change')
    expect(forceKeySetup().checked).toBe(false)
    expect(forceKeySetup().disabled).toBe(true)
  })

  it('names the section headings and checkbox hints', async () => {
    const wrapper = await mountSettings()
    expect(wrapper.findAll('h3').map((h) => h.text())).toEqual([
      'Encryption mode', 'Additional options', 'Voice & video encryption', 'Server statistics', 'About end-to-end encryption',
    ])
    const voice = wrapper.findAll('input[type="checkbox"]')[1]
    expect(document.getElementById(voice.attributes('aria-describedby')!)?.textContent).toContain('Every voice channel encrypts calls')
  })
})
