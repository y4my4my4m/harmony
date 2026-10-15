import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { useI18n } from 'vue-i18n'
import ServerEmojiManagement from '../ServerEmojiManagement.vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params?: Record<string, unknown> | string) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return typeof params === 'string' ? params : key
    const values = typeof params === 'object' ? params : {}
    return message.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t, locale: { value: 'en' } }) }
})

const h = vi.hoisted(() => ({
  uploadEmoji: vi.fn(),
  renameEmoji: vi.fn(),
  deleteEmoji: vi.fn(),
  bulkDeleteEmojis: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  settings: { maxCustomEmojisPerServer: 50 },
}))

vi.mock('vue-toastification', () => ({ useToast: () => h.toast }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/services/emojiService', () => ({
  uploadEmoji: h.uploadEmoji,
  deleteEmoji: h.deleteEmoji,
  renameEmoji: h.renameEmoji,
  bulkDeleteEmojis: h.bulkDeleteEmojis,
}))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => ({ settings: h.settings }) }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'me' } }) }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }) }))
vi.mock('@/utils/emojiUtils', () => ({ getEmojiUrl: (url: string) => url }))
vi.mock('@/utils/uploadValidation', () => ({
  UploadRejectedError: class extends Error {},
  imageSourceError: () => null,
}))

enableAutoUnmount(afterEach)

const SERVER = 'server-1'
const emoji = (id: string, name: string) => ({
  id, name, url: `https://cdn.test/${id}.png`, server_id: SERVER, file_size: 2048, created_at: '2026-01-02T00:00:00Z',
})

function mountManager() {
  const { t } = useI18n()
  return mount(ServerEmojiManagement, {
    attachTo: document.body,
    props: {
      emojis: [emoji('e1', 'party'), emoji('e2', 'wave')] as any,
      allowCrossServer: false,
      serverId: SERVER,
      ownerId: 'owner',
      loading: false,
      permissions: { canUpload: true, canDelete: true, canRename: true, canManageCrossServer: true },
    },
    global: { mocks: { $t: t } },
  })
}

const nameOf = (el: Element) =>
  (el.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .join(' ')

beforeEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
  h.uploadEmoji.mockReset()
  h.renameEmoji.mockReset()
  h.settings.maxCustomEmojisPerServer = 50
})

describe('ServerEmojiManagement accessibility', () => {
  it('exposes the emoji upload as a named, tabbable native file input inside its label', () => {
    const wrapper = mountManager()
    const input = wrapper.get('[data-testid="emoji-upload-input"]')
    const el = input.element as HTMLInputElement

    expect(el.type).toBe('file')
    expect(el.classList.contains('sr-only')).toBe(true)
    expect(el.closest('label')).toBe(wrapper.get('[data-testid="emoji-upload-area"]').element)
    expect(el.tabIndex).toBe(0)
    expect(el.disabled).toBe(false)
    expect(nameOf(el)).toBe('Upload emoji')
    expect(document.getElementById(el.getAttribute('aria-describedby')!)?.textContent).toContain('128×128px')
    expect(document.getElementById(el.getAttribute('aria-describedby')!)?.textContent).not.toContain('SVG')
    expect(el.accept).not.toContain('svg')

    el.focus()
    expect(document.activeElement).toBe(el)
  })

  it('starts an upload when a file is chosen in the input', async () => {
    h.uploadEmoji.mockResolvedValue(emoji('e3', 'cat'))
    const wrapper = mountManager()
    const input = wrapper.get('[data-testid="emoji-upload-input"]')
    const file = new File(['png'], 'cat.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })

    await input.trigger('change')
    await flushPromises()

    expect(h.uploadEmoji).toHaveBeenCalledWith(SERVER, 'me', file)
    expect(wrapper.emitted('emoji-uploaded')?.[0]?.[0]).toMatchObject({ id: 'e3' })
  })

  it('names each emoji action after the emoji', () => {
    const wrapper = mountManager()
    const item = wrapper.findAll('.emoji-item')[0]

    expect(item.get('.copy-btn').attributes('aria-label')).toBe('Copy :party:')
    expect(item.get('.rename-btn').attributes('aria-label')).toBe('Rename :party:')
    expect(item.get('.delete-btn').attributes('aria-label')).toBe('Delete :party:')
    for (const button of item.findAll('button')) {
      expect(button.attributes('type')).toBe('button')
      expect(button.get('svg').attributes('aria-hidden')).toBe('true')
    }
  })

  it('labels the rename field, keeps Escape from the settings view and returns focus to Rename', async () => {
    const wrapper = mountManager()
    const rename = wrapper.findAll('.rename-btn')[0]
    await rename.trigger('click')
    await flushPromises()

    const field = wrapper.get('[data-testid="emoji-rename-input"]')
    expect(field.attributes('aria-label')).toBe('New name for :party:')
    expect(document.activeElement).toBe(field.element)

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    field.element.dispatchEvent(escape)
    await flushPromises()

    expect(escape.defaultPrevented).toBe(true)
    expect(wrapper.find('[data-testid="emoji-rename-input"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.findAll('.rename-btn')[0].element)
    expect(h.renameEmoji).not.toHaveBeenCalled()
  })

  it('saves a rename on Enter once', async () => {
    h.renameEmoji.mockResolvedValue(true)
    const wrapper = mountManager()
    await wrapper.findAll('.rename-btn')[0].trigger('click')
    await flushPromises()

    const field = wrapper.get('[data-testid="emoji-rename-input"]')
    await field.setValue('fiesta')
    await field.trigger('keydown', { key: 'Enter' })
    await field.trigger('blur')
    await flushPromises()

    expect(h.renameEmoji).toHaveBeenCalledTimes(1)
    expect(h.renameEmoji).toHaveBeenCalledWith('e1', 'fiesta', SERVER)
  })

  it('labels the cross-server sharing switch', () => {
    const wrapper = mountManager()
    const toggle = wrapper.get('.toggle-switch input').element
    expect(toggle.getAttribute('role')).toBe('switch')
    expect(nameOf(toggle)).toBe('Allow cross-server emojis')
  })

  it('counts against the per-server limit; 0 is no limit', () => {
    expect(mountManager().get('[data-testid="emoji-count"]').text()).toBe('2 / 50')
    h.settings.maxCustomEmojisPerServer = 0
    expect(mountManager().get('[data-testid="emoji-count"]').text()).toBe('2')
  })

  it('emits a rename as an updated list', async () => {
    h.renameEmoji.mockResolvedValue(true)
    const wrapper = mountManager()
    await wrapper.findAll('.rename-btn')[0].trigger('click')
    await flushPromises()
    const field = wrapper.get('[data-testid="emoji-rename-input"]')
    await field.setValue('fiesta')
    await field.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.emitted('update:emojis')?.[0]?.[0]).toMatchObject([{ id: 'e1', name: 'fiesta' }, { id: 'e2', name: 'wave' }])
  })

  it('deletes one emoji through deleteEmoji and several through bulkDeleteEmojis', async () => {
    h.deleteEmoji.mockResolvedValue(true)
    h.bulkDeleteEmojis.mockResolvedValue({ success: ['e1', 'e2'], failed: [] })
    const wrapper = mountManager()
    await wrapper.findAll('.delete-btn')[1].trigger('click')
    await flushPromises()
    expect(h.deleteEmoji).toHaveBeenCalledWith('e2')
    expect(wrapper.emitted('emoji-deleted')?.[0]).toEqual(['e2'])

    await wrapper.get('.header-right button').trigger('click')
    await flushPromises()
    for (const box of wrapper.findAll('[role="checkbox"]')) await box.trigger('click')
    await wrapper.get('[data-testid="emoji-bulk-delete"]').trigger('click')
    await flushPromises()
    expect(h.bulkDeleteEmojis).toHaveBeenCalledWith(['e1', 'e2'])
    expect(wrapper.emitted('emojis-bulk-deleted')?.[0]).toEqual([['e1', 'e2']])
  })
})
