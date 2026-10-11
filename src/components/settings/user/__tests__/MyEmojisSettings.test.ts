/**
 * Settings > My emojis lists the caller's user-scope emojis, renames inline through
 * rename_my_emoji (Escape cancels, focus returns to the row's Rename button), deletes after
 * a confirmation, announces each result and refreshes the picker's personal groups.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MyEmojisSettings from '../MyEmojisSettings.vue'

vi.mock('vue-i18n', async () => {
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
  return { useI18n: () => ({ t, locale: { value: 'en' } }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/LoadingSpinner.vue', () => stub('LoadingSpinner'))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const confirm = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm }) }))

const announcer = vi.hoisted(() => ({ polite: vi.fn(), assertive: vi.fn() }))
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => announcer }))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentProfileId: vi.fn(async () => 'me') },
}))

const service = vi.hoisted(() => ({
  listMyEmojis: vi.fn(),
  renameMyEmoji: vi.fn(),
  deleteMyEmoji: vi.fn(),
  refreshPersonalEmojis: vi.fn(async () => {}),
}))
vi.mock('@/services/UserEmojiService', () => ({
  MY_EMOJI_NAME: /^[A-Za-z0-9_-]{2,64}$/,
  ...service,
}))

const emoji = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  url: `https://cdn.test/${id}.png`,
  is_ai_generated: false,
  usage_count: 0,
  created_at: '2026-10-01T00:00:00Z',
  ...extra,
})

let wrapper: VueWrapper | null = null

async function render() {
  wrapper = mount(MyEmojisSettings, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

const rows = (w: VueWrapper) => w.findAll('.my-emoji-row')
const action = (w: VueWrapper, row: number, name: 'rename' | 'delete') =>
  rows(w)[row].find(`[data-action="${name}"]`)

beforeEach(() => {
  vi.clearAllMocks()
  service.listMyEmojis.mockResolvedValue([
    emoji('e1', 'party_cat', { is_ai_generated: true, usage_count: 3 }),
    emoji('e2', 'blob'),
  ])
  service.renameMyEmoji.mockResolvedValue(undefined)
  service.deleteMyEmoji.mockResolvedValue(undefined)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('MyEmojisSettings', () => {
  it('lists the emojis with name, AI badge, usage and named actions', async () => {
    const w = await render()
    expect(service.listMyEmojis).toHaveBeenCalledWith('me')
    expect(w.find('ul').attributes('aria-label')).toBe('Your emojis')
    expect(rows(w)).toHaveLength(2)
    expect(rows(w)[0].find('.my-emoji-name').text()).toBe(':party_cat:')
    expect(rows(w)[0].find('.my-emoji-badge .sr-only').text()).toBe('AI-generated')
    expect(rows(w)[0].text()).toContain('used 3 times')
    expect(rows(w)[0].find('img').attributes('alt')).toBe('')
    expect(rows(w)[1].find('.my-emoji-badge').exists()).toBe(false)
    expect(rows(w)[1].text()).toContain('not used yet')
    expect(action(w, 0, 'rename').attributes('aria-label')).toBe('Rename :party_cat:')
    expect(action(w, 1, 'delete').attributes('aria-label')).toBe('Delete :blob:')
  })

  it('shows the empty state', async () => {
    service.listMyEmojis.mockResolvedValue([])
    const w = await render()
    expect(w.text()).toContain('You have no personal emojis yet.')
    expect(w.find('ul').exists()).toBe(false)
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

  it('Escape cancels an inline rename and returns focus to Rename', async () => {
    const w = await render()
    await action(w, 0, 'rename').trigger('click')
    await flushPromises()
    const input = w.find('.my-emoji-input')
    expect((input.element as HTMLInputElement).value).toBe('party_cat')
    expect(document.activeElement).toBe(input.element)
    expect(input.attributes('aria-label')).toBe('New name for :party_cat:')
    expect(input.attributes('aria-describedby')).toBe('my-emoji-rename-hint')

    await input.setValue('ignored')
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    input.element.dispatchEvent(esc)
    await flushPromises()
    expect(esc.defaultPrevented).toBe(true)
    expect(w.find('.my-emoji-input').exists()).toBe(false)
    expect(document.activeElement).toBe(action(w, 0, 'rename').element)
    expect(service.renameMyEmoji).not.toHaveBeenCalled()
    expect(rows(w)[0].find('.my-emoji-name').text()).toBe(':party_cat:')
  })

  it('rejects an invalid name in place', async () => {
    const w = await render()
    await action(w, 1, 'rename').trigger('click')
    await w.find('.my-emoji-input').setValue('bad name')
    await w.find('.my-emoji-rename').trigger('submit')
    await flushPromises()
    expect(service.renameMyEmoji).not.toHaveBeenCalled()
    const input = w.find('.my-emoji-input')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toBe('my-emoji-rename-error')
    expect(w.find('#my-emoji-rename-error').text()).toBe('Names are 2 to 64 letters, digits, _ or -.')
    expect(announcer.assertive).toHaveBeenCalledWith('Names are 2 to 64 letters, digits, _ or -.')
  })

  it('renames, announces, refreshes the picker and focuses Rename', async () => {
    const w = await render()
    await action(w, 0, 'rename').trigger('click')
    await w.find('.my-emoji-input').setValue(' dancing_cat ')
    await w.find('.my-emoji-rename').trigger('submit')
    await flushPromises()
    expect(service.renameMyEmoji).toHaveBeenCalledWith('e1', 'dancing_cat')
    expect(rows(w)[0].find('.my-emoji-name').text()).toBe(':dancing_cat:')
    expect(announcer.polite).toHaveBeenCalledWith('Renamed :party_cat: to :dancing_cat:')
    expect(service.refreshPersonalEmojis).toHaveBeenCalledWith('me')
    expect(document.activeElement).toBe(action(w, 0, 'rename').element)
  })

  it('reports a name the owner already uses', async () => {
    service.renameMyEmoji.mockRejectedValueOnce({ code: '23505', message: 'exists' })
    const w = await render()
    await action(w, 1, 'rename').trigger('click')
    await w.find('.my-emoji-input').setValue('party_cat')
    await w.find('.my-emoji-rename').trigger('submit')
    await flushPromises()
    expect(w.find('#my-emoji-rename-error').text()).toBe('You already have an emoji with that name.')
    expect(announcer.assertive).toHaveBeenCalledWith('You already have an emoji with that name.')
    expect(service.refreshPersonalEmojis).not.toHaveBeenCalled()
  })

  it('deletes only on confirm, then moves focus to the next row', async () => {
    const w = await render()
    confirm.mockResolvedValueOnce(false)
    await action(w, 0, 'delete').trigger('click')
    await flushPromises()
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Delete emoji', dangerAction: true })
    expect(confirm.mock.calls[0][0].message).toContain('Delete :party_cat:?')
    expect(service.deleteMyEmoji).not.toHaveBeenCalled()

    confirm.mockResolvedValueOnce(true)
    await action(w, 0, 'delete').trigger('click')
    await flushPromises()
    expect(service.deleteMyEmoji).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), 'me')
    expect(rows(w)).toHaveLength(1)
    expect(announcer.polite).toHaveBeenCalledWith('Deleted :party_cat:')
    expect(service.refreshPersonalEmojis).toHaveBeenCalledWith('me')
    expect(document.activeElement).toBe(action(w, 0, 'delete').element)

    confirm.mockResolvedValueOnce(true)
    await action(w, 0, 'delete').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('You have no personal emojis yet.')
    expect(document.activeElement).toBe(w.find('#my-emojis-title').element)
  })

  it('keeps the row and shows an error when the delete fails', async () => {
    service.deleteMyEmoji.mockRejectedValueOnce({ code: 'P0002' })
    confirm.mockResolvedValueOnce(true)
    const w = await render()
    await action(w, 1, 'delete').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('That emoji no longer exists.')
    expect(rows(w)).toHaveLength(2)
    expect(announcer.polite).not.toHaveBeenCalled()
  })
})
