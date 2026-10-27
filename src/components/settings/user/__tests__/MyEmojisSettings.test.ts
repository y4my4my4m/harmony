/**
 * Settings > My emojis: the caller's user-scope emojis in EmojiLibraryManager with the
 * personal adapter. Uploads go through uploadMyEmoji, renames through rename_my_emoji,
 * deletes through the owner policy; each change refreshes the picker's personal groups.
 * The count reads against instance_config max_personal_emojis_per_user; 0 turns uploads off.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MyEmojisSettings from '../MyEmojisSettings.vue'

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}, plural?: number) => {
    let message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    if (plural !== undefined) {
      const forms = message.split(' | ')
      message = forms.length === 3 ? forms[Math.min(plural, 2)] : forms[plural === 1 ? 0 : 1]
    }
    return message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t, locale: { value: 'en' } }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/utils/emojiUtils', () => ({ getEmojiUrl: (url: string) => url }))
vi.mock('@/utils/uploadValidation', () => ({
  UploadRejectedError: class UploadRejectedError extends Error {},
  imageSourceError: () => null,
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const confirm = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm }) }))

const announcer = vi.hoisted(() => ({ polite: vi.fn(), assertive: vi.fn() }))
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => announcer }))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentProfileId: vi.fn(async () => 'me') },
}))

const settings = vi.hoisted(() => ({
  store: { settings: { maxPersonalEmojisPerUser: 50 }, fetchSettings: vi.fn(async () => {}) },
}))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => settings.store }))

const service = vi.hoisted(() => ({
  listMyEmojis: vi.fn(),
  uploadMyEmoji: vi.fn(),
  renameMyEmoji: vi.fn(),
  deleteMyEmoji: vi.fn(),
  deleteMyEmojis: vi.fn(),
  refreshPersonalEmojis: vi.fn(async () => {}),
}))
vi.mock('@/services/UserEmojiService', () => service)

const emoji = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  url: `https://cdn.test/${id}.png`,
  is_ai_generated: false,
  usage_count: 0,
  file_size: 1024,
  created_at: '2026-10-01T00:00:00Z',
  ...extra,
})

let wrapper: VueWrapper | null = null

async function render() {
  wrapper = mount(MyEmojisSettings, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

const rows = (w: VueWrapper) => w.findAll('.emoji-item')
const action = (w: VueWrapper, row: number, name: 'rename' | 'delete') => rows(w)[row].find(`[data-action="${name}"]`)

async function pick(w: VueWrapper, file: File) {
  const input = w.get('[data-testid="emoji-upload-input"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  settings.store.settings.maxPersonalEmojisPerUser = 50
  service.listMyEmojis.mockResolvedValue([
    emoji('e1', 'party_cat', { is_ai_generated: true, usage_count: 3 }),
    emoji('e2', 'blob'),
  ])
  service.renameMyEmoji.mockResolvedValue(undefined)
  service.deleteMyEmoji.mockResolvedValue(undefined)
  service.uploadMyEmoji.mockImplementation(async () => emoji('e3', 'cat'))
  confirm.mockResolvedValue(true)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('MyEmojisSettings', () => {
  it('lists the emojis with the AI badge, usage and the count against the limit', async () => {
    const w = await render()
    expect(service.listMyEmojis).toHaveBeenCalledWith('me')
    expect(settings.store.fetchSettings).toHaveBeenCalledWith(true)
    expect(w.get('[data-testid="emoji-count"]').text()).toBe('2 / 50')
    expect(rows(w)).toHaveLength(2)
    expect(rows(w)[0].find('.emoji-name').text()).toBe(':party_cat:')
    expect(rows(w)[0].find('.emoji-badge .sr-only').text()).toBe('AI-generated')
    expect(rows(w)[0].text()).toContain('used 3 times')
    expect(rows(w)[1].find('.emoji-badge').exists()).toBe(false)
    expect(rows(w)[1].text()).toContain('not used yet')
    expect(action(w, 0, 'rename').attributes('aria-label')).toBe('Rename :party_cat:')
    expect(action(w, 1, 'delete').attributes('aria-label')).toBe('Delete :blob:')
  })

  it('shows the empty state', async () => {
    service.listMyEmojis.mockResolvedValue([])
    const w = await render()
    expect(w.text()).toContain('You have no personal emojis yet.')
    expect(rows(w)).toHaveLength(0)
  })

  it('offers a retry when loading fails', async () => {
    service.listMyEmojis.mockRejectedValueOnce(new Error('down'))
    const w = await render()
    expect(w.text()).toContain('Could not load your emojis.')
    await w.find('button.btn-secondary').trigger('click')
    await flushPromises()
    expect(service.listMyEmojis).toHaveBeenCalledTimes(2)
    expect(rows(w)).toHaveLength(2)
  })

  it('uploads through uploadMyEmoji, lists the new emoji first and refreshes the picker', async () => {
    const w = await render()
    const file = new File(['png'], 'cat.png', { type: 'image/png' })
    await pick(w, file)
    expect(service.uploadMyEmoji).toHaveBeenCalledWith('me', file, { onProgress: expect.any(Function) })
    expect(rows(w)[0].find('.emoji-name').text()).toBe(':cat:')
    expect(w.get('[data-testid="emoji-count"]').text()).toBe('3 / 50')
    expect(service.refreshPersonalEmojis).toHaveBeenCalledWith('me')
    expect(toast.success).toHaveBeenCalledWith('Emoji "cat" uploaded')
  })

  it('reports the server limit refusal and rereads the instance settings', async () => {
    service.uploadMyEmoji.mockRejectedValueOnce({ code: '23514', message: 'PERSONAL_EMOJI_LIMIT: at most 2 personal emojis per user' })
    const w = await render()
    settings.store.fetchSettings.mockClear()
    await pick(w, new File(['png'], 'cat.png', { type: 'image/png' }))
    expect(toast.error).toHaveBeenCalledWith('Maximum number of emojis reached (2)')
    expect(settings.store.fetchSettings).toHaveBeenCalledWith(true)
    expect(rows(w)).toHaveLength(2)
  })

  it('refuses an upload at the limit without calling the service', async () => {
    settings.store.settings.maxPersonalEmojisPerUser = 2
    const w = await render()
    await pick(w, new File(['png'], 'cat.png', { type: 'image/png' }))
    expect(service.uploadMyEmoji).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Maximum number of emojis reached (2)')
  })

  it('hides the upload area when personal emojis are off', async () => {
    settings.store.settings.maxPersonalEmojisPerUser = 0
    const w = await render()
    expect(w.find('[data-testid="emoji-upload-input"]').exists()).toBe(false)
    expect(w.get('[data-testid="emoji-upload-notice"]').text()).toBe('Personal emojis are turned off on this instance.')
    expect(rows(w)).toHaveLength(2)
  })

  it('renames through renameMyEmoji and refreshes the picker', async () => {
    const w = await render()
    await action(w, 0, 'rename').trigger('click')
    await flushPromises()
    const input = w.get('[data-testid="emoji-rename-input"]')
    expect(input.attributes('aria-label')).toBe('New name for :party_cat:')
    await input.setValue(' dancing_cat ')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(service.renameMyEmoji).toHaveBeenCalledWith('e1', 'dancing_cat')
    expect(rows(w)[0].find('.emoji-name').text()).toBe(':dancing_cat:')
    expect(announcer.polite).toHaveBeenCalledWith('Renamed :party_cat: to :dancing_cat:')
    expect(service.refreshPersonalEmojis).toHaveBeenCalledWith('me')
    expect(document.activeElement).toBe(action(w, 0, 'rename').element)
  })

  it('reports a name the owner already uses in place', async () => {
    service.renameMyEmoji.mockRejectedValueOnce({ code: '23505', message: 'exists' })
    const w = await render()
    await action(w, 1, 'rename').trigger('click')
    await flushPromises()
    const input = w.get('[data-testid="emoji-rename-input"]')
    await input.setValue('party_cat')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(document.getElementById(input.attributes('aria-describedby')!)?.textContent?.trim())
      .toBe('You already have an emoji with that name.')
    expect(announcer.assertive).toHaveBeenCalledWith('You already have an emoji with that name.')
    expect(service.refreshPersonalEmojis).not.toHaveBeenCalled()
  })

  it('deletes after the personal confirmation and refreshes the picker', async () => {
    const w = await render()
    await action(w, 0, 'delete').trigger('click')
    await flushPromises()
    expect(confirm.mock.calls[0][0].message).toContain('Delete :party_cat:?')
    expect(service.deleteMyEmoji).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), 'me')
    expect(rows(w)).toHaveLength(1)
    expect(announcer.polite).toHaveBeenCalledWith('Deleted :party_cat:')
    expect(service.refreshPersonalEmojis).toHaveBeenCalledWith('me')
    expect(document.activeElement).toBe(action(w, 0, 'delete').element)
  })

  it('keeps the row and names the reason when the delete fails', async () => {
    service.deleteMyEmoji.mockRejectedValueOnce({ code: 'P0002' })
    const w = await render()
    await action(w, 1, 'delete').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('That emoji no longer exists.')
    expect(rows(w)).toHaveLength(2)
    expect(announcer.polite).not.toHaveBeenCalled()
  })
})
