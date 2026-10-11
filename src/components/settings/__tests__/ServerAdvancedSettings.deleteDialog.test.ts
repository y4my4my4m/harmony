import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { useI18n } from 'vue-i18n'
import ServerAdvancedSettings from '../ServerAdvancedSettings.vue'
import { hasOpenLayer, resetLayersForTests } from '@/utils/a11y/layers'

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    return message.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t, locale: { value: 'en' } }) }
})

const h = vi.hoisted(() => ({
  deleteServer: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: h.push }) }))
vi.mock('vue-toastification', () => ({ useToast: () => h.toast }))
vi.mock('@/stores/server', () => ({ useServerStore: () => ({ deleteServer: h.deleteServer }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'owner' } } }) }))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ fetchServersForUser: vi.fn(), servers: [] }),
}))

enableAutoUnmount(afterEach)

const SERVER_NAME = 'Lighthouse'

function mountSettings() {
  const { t } = useI18n()
  return mount(ServerAdvancedSettings, {
    attachTo: document.body,
    props: {
      serverId: 'srv-1',
      serverName: SERVER_NAME,
      createdAt: '2026-01-01T00:00:00Z',
      loading: false,
      permissions: { canDeleteServer: true },
    },
    global: { mocks: { $t: t } },
  })
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="delete-server-dialog"]')
const byId = (id: string | null) => (id ? document.getElementById(id) : null)

async function openDialog(wrapper: ReturnType<typeof mountSettings>) {
  const opener = wrapper.get('[data-testid="delete-server-open"]')
  ;(opener.element as HTMLElement).focus()
  await opener.trigger('click')
  await flushPromises()
  return opener.element as HTMLElement
}

function press(target: EventTarget, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetLayersForTests()
  h.deleteServer.mockReset()
  h.push.mockReset()
})

describe('ServerAdvancedSettings delete-server dialog', () => {
  it('is a labelled, described alertdialog with focus in the confirmation field', async () => {
    const wrapper = mountSettings()
    const opener = wrapper.get('[data-testid="delete-server-open"]')
    expect(opener.text()).toBe('Delete server')
    expect(opener.attributes('aria-haspopup')).toBe('dialog')

    await openDialog(wrapper)
    const el = dialog()!
    expect(el.getAttribute('role')).toBe('alertdialog')
    expect(el.getAttribute('aria-modal')).toBe('true')
    expect(byId(el.getAttribute('aria-labelledby'))?.textContent?.trim()).toBe('Delete server')
    const description = el.getAttribute('aria-describedby')!.split(' ').map((id) => byId(id)?.textContent?.trim()).join(' ')
    expect(description).toContain('This action is irreversible')
    expect(description).toContain(SERVER_NAME)

    const input = el.querySelector<HTMLInputElement>('[data-testid="delete-server-confirm-input"]')!
    expect(document.activeElement).toBe(input)
    const label = el.querySelector(`label[for="${input.id}"]`)
    expect(label?.textContent).toContain('Type the server name to confirm:')
    expect(label?.textContent).toContain(SERVER_NAME)
    expect(hasOpenLayer()).toBe(true)
  })

  it('closes on Escape without reaching the settings view and returns focus to the opener', async () => {
    const wrapper = mountSettings()
    const back = vi.fn()
    // Mirrors ServerSettings.vue handleSettingsKeydown.
    const settingsKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || hasOpenLayer()) return
      back()
    }
    document.addEventListener('keydown', settingsKeydown)
    try {
      const opener = await openDialog(wrapper)
      const input = dialog()!.querySelector<HTMLInputElement>('input')!

      const event = press(input, 'Escape')
      await flushPromises()

      expect(event.defaultPrevented).toBe(true)
      expect(dialog()).toBeNull()
      expect(back).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(opener)
    } finally {
      document.removeEventListener('keydown', settingsKeydown)
    }
  })

  it('wraps Tab inside the dialog', async () => {
    const wrapper = mountSettings()
    await openDialog(wrapper)
    const confirm = dialog()!.querySelector<HTMLElement>('[data-testid="delete-server-confirm"]')!
    confirm.focus()

    const event = press(confirm, 'Tab')

    expect(event.defaultPrevented).toBe(true)
    expect(dialog()!.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(confirm)
  })

  it('links a mismatch error to the field and explains the unavailable Delete button', async () => {
    const wrapper = mountSettings()
    await openDialog(wrapper)
    const el = dialog()!
    const input = el.querySelector<HTMLInputElement>('input')!
    const confirm = el.querySelector<HTMLElement>('[data-testid="delete-server-confirm"]')!

    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    expect(byId(confirm.getAttribute('aria-describedby'))?.tagName).toBe('LABEL')

    input.value = 'Lighthous'
    input.dispatchEvent(new Event('input'))
    expect(input.getAttribute('aria-invalid')).toBeNull()
    input.dispatchEvent(new Event('change'))
    await flushPromises()

    expect(input.getAttribute('aria-invalid')).toBe('true')
    const error = byId(input.getAttribute('aria-describedby'))!
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent?.trim()).toBe('Server name does not match')

    confirm.click()
    await flushPromises()
    expect(h.deleteServer).not.toHaveBeenCalled()
    expect(byId(input.getAttribute('aria-describedby'))?.textContent?.trim()).toBe('Type the exact server name to confirm')

    input.value = SERVER_NAME
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(confirm.getAttribute('aria-disabled')).toBeNull()
  })

  it('deletes on Enter once the name matches', async () => {
    h.deleteServer.mockResolvedValue(true)
    const wrapper = mountSettings()
    await openDialog(wrapper)
    const input = dialog()!.querySelector<HTMLInputElement>('input')!
    input.value = SERVER_NAME
    input.dispatchEvent(new Event('input'))
    await flushPromises()

    press(input, 'Enter')
    await flushPromises()

    expect(h.deleteServer).toHaveBeenCalledWith('srv-1', 'owner')
    expect(h.push).toHaveBeenCalledWith('/dm')
  })
})
