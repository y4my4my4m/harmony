/**
 * EmojiLibraryManager: the shared upload / list / rename / delete surface of server emoji
 * management and Settings > My emojis, driven by an adapter. Limits come from `max` (null is
 * no limit); adapter failures are worded by describeError.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import EmojiLibraryManager from '../EmojiLibraryManager.vue'
import { emojiUploadCandidates, formatEmojiFileSize, hasRoomFor, type EmojiLibraryAdapter, type LibraryEmoji } from '../emojiLibrary'

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

const h = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  confirm: vi.fn(async () => true),
  announcer: { polite: vi.fn(), assertive: vi.fn() },
}))

vi.mock('vue-toastification', () => ({ useToast: () => h.toast }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: h.confirm }) }))
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => h.announcer }))
vi.mock('@/utils/emojiUtils', () => ({ getEmojiUrl: (url: string) => url }))
vi.mock('@/utils/uploadValidation', () => ({
  UploadRejectedError: class UploadRejectedError extends Error {},
  imageSourceError: () => null,
}))

enableAutoUnmount(afterEach)

const emoji = (id: string, name: string, extra: Partial<LibraryEmoji> = {}): LibraryEmoji => ({
  id, name, url: `https://cdn.test/${id}.png`, file_size: 2048, created_at: '2026-10-01T00:00:00Z', ...extra,
})
const png = (name: string) => new File(['png'], name, { type: 'image/png' })

let adapter: { [K in keyof EmojiLibraryAdapter]-?: ReturnType<typeof vi.fn> }

function render(props: Record<string, unknown> = {}) {
  const wrapper: VueWrapper<any> = mount(EmojiLibraryManager as any, {
    attachTo: document.body,
    props: {
      emojis: [emoji('e1', 'party'), emoji('e2', 'wave')],
      adapter,
      max: 50,
      texts: { title: 'Your emojis', empty: 'Nothing here.', confirmDelete: (name: string) => `Delete :${name}:?` },
      // The parent owns the list: mirror its updates.
      onDeleted: (ids: string[]) => wrapper.setProps({ emojis: wrapper.props('emojis').filter((e: LibraryEmoji) => !ids.includes(e.id)) }),
      onUploaded: (e: LibraryEmoji) => wrapper.setProps({ emojis: [e, ...wrapper.props('emojis')] }),
      ...props,
    },
  })
  return wrapper
}

async function pick(wrapper: VueWrapper<any>, files: File[]) {
  const input = wrapper.get('[data-testid="emoji-upload-input"]')
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
  await flushPromises()
}

const item = (wrapper: VueWrapper<any>, id: string) => wrapper.get(`[data-emoji-id="${id}"]`)

beforeEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
  h.confirm.mockResolvedValue(true)
  adapter = {
    upload: vi.fn(async (file: File) => emoji(`new-${file.name}`, file.name.replace(/\..*$/, ''))),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    removeMany: vi.fn(async (rows: LibraryEmoji[]) => ({ success: rows.map((r) => r.id), failed: [] })),
    describeError: vi.fn(() => null),
  }
})

describe('emojiLibrary helpers', () => {
  it('keeps image files of a multi-file pick and names the rest', () => {
    const big = new File(['x'], 'big.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 })
    const picked = [png('a.png'), new File(['<svg/>'], 'b.svg', { type: 'image/svg+xml' }), new File(['t'], 'c.txt', { type: 'text/plain' }), big]
    const { files, notImage, tooLarge } = emojiUploadCandidates(picked)
    expect(files.map((f) => f.name)).toEqual(['a.png'])
    expect(notImage).toEqual(['b.svg', 'c.txt'])
    expect(tooLarge).toEqual(['big.png'])
  })

  it('treats a null max as no limit', () => {
    expect(hasRoomFor(1000, 5, null)).toBe(true)
    expect(hasRoomFor(1, 1, 2)).toBe(true)
    expect(hasRoomFor(2, 1, 2)).toBe(false)
    expect(hasRoomFor(0, 1, 0)).toBe(false)
  })

  it('formats sizes', () => {
    expect(formatEmojiFileSize(0)).toBe('0 B')
    expect(formatEmojiFileSize(2048)).toBe('2 KB')
    expect(formatEmojiFileSize(1536 * 1024)).toBe('1.5 MB')
  })
})

describe('EmojiLibraryManager', () => {
  it('shows the count against the limit, or the count alone without one', async () => {
    const wrapper = render()
    expect(wrapper.get('[data-testid="emoji-count"]').text()).toBe('2 / 50')
    await wrapper.setProps({ max: null })
    expect(wrapper.get('[data-testid="emoji-count"]').text()).toBe('2')
  })

  it('lists emojis as a named list with the AI badge, usage, size and actions', () => {
    const wrapper = render({ emojis: [emoji('e1', 'party', { is_ai_generated: true, usage_count: 3 }), emoji('e2', 'wave')] })
    const list = wrapper.get('[role="list"]')
    expect(document.getElementById(list.attributes('aria-labelledby')!)?.textContent).toBe('Your emojis')
    expect(wrapper.findAll('[role="listitem"]')).toHaveLength(2)
    expect(item(wrapper, 'e1').get('.emoji-badge .sr-only').text()).toBe('AI-generated')
    expect(item(wrapper, 'e1').text()).toContain('used 3 times')
    expect(item(wrapper, 'e1').text()).toContain('2 KB')
    expect(item(wrapper, 'e2').find('.emoji-badge').exists()).toBe(false)
    expect(item(wrapper, 'e1').get('img').attributes('alt')).toBe('')
    expect(item(wrapper, 'e2').get('[data-action="delete"]').attributes('aria-label')).toBe('Delete :wave:')
  })

  it('shows the empty state and, without upload rights, the notice in place of the upload area', () => {
    const wrapper = render({ emojis: [], canUpload: false, uploadNotice: 'Uploads are off.' })
    expect(wrapper.text()).toContain('Nothing here.')
    expect(wrapper.find('[data-testid="emoji-upload-input"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="emoji-upload-notice"]').text()).toBe('Uploads are off.')
  })

  it('uploads one file through the adapter', async () => {
    const wrapper = render()
    const file = png('cat.png')
    await pick(wrapper, [file])
    expect(adapter.upload).toHaveBeenCalledWith(file, { onProgress: expect.any(Function) })
    expect(wrapper.emitted('uploaded')?.[0]?.[0]).toMatchObject({ name: 'cat' })
    expect(h.toast.success).toHaveBeenCalledWith('Emoji "cat" uploaded')
    expect(wrapper.get('[data-testid="emoji-count"]').text()).toBe('3 / 50')
  })

  it('refuses an upload past the limit before calling the adapter', async () => {
    const wrapper = render({ max: 2 })
    await pick(wrapper, [png('cat.png')])
    expect(adapter.upload).not.toHaveBeenCalled()
    expect(h.toast.error).toHaveBeenCalledWith('Maximum number of emojis reached (2)')
  })

  it('words an adapter failure through describeError, and an UploadRejectedError by its message', async () => {
    const { UploadRejectedError } = await import('@/utils/uploadValidation')
    const wrapper = render()
    adapter.upload.mockRejectedValueOnce({ code: '23514' })
    adapter.describeError.mockReturnValueOnce('Library full')
    await pick(wrapper, [png('cat.png')])
    expect(adapter.describeError).toHaveBeenCalledWith('upload', { code: '23514' })
    expect(h.toast.error).toHaveBeenLastCalledWith('Library full')

    adapter.upload.mockRejectedValueOnce(new UploadRejectedError('Too big'))
    await pick(wrapper, [png('cat.png')])
    expect(h.toast.error).toHaveBeenLastCalledWith('Too big')

    adapter.upload.mockRejectedValueOnce(new Error('network'))
    await pick(wrapper, [png('cat.png')])
    expect(h.toast.error).toHaveBeenLastCalledWith('Failed to upload emoji')
  })

  it('bulk-uploads the image files in order, skipping the rest', async () => {
    const wrapper = render()
    await pick(wrapper, [png('a.png'), new File(['t'], 'notes.txt', { type: 'text/plain' }), png('b.png')])
    expect(adapter.upload.mock.calls.map(([f]) => (f as File).name)).toEqual(['a.png', 'b.png'])
    expect(wrapper.emitted('uploaded')).toHaveLength(2)
    expect(h.toast.warning).toHaveBeenCalledWith(expect.stringContaining('1'))
    expect(h.toast.success).toHaveBeenCalledWith('2 emojis uploaded')
  })

  it('refuses a bulk upload that would pass the limit', async () => {
    const wrapper = render({ max: 3 })
    await pick(wrapper, [png('a.png'), png('b.png')])
    expect(adapter.upload).not.toHaveBeenCalled()
    expect(h.toast.error).toHaveBeenCalledWith('Cannot upload 2 emoji(s): would exceed the limit of 3 (currently 2)')
  })

  it('renames on Enter, announces it and returns focus to Rename', async () => {
    const wrapper = render()
    await item(wrapper, 'e1').get('[data-action="rename"]').trigger('click')
    await flushPromises()
    const field = wrapper.get('[data-testid="emoji-rename-input"]')
    expect(document.activeElement).toBe(field.element)
    expect(document.getElementById(field.attributes('aria-describedby')!)?.textContent).toContain('Enter saves')

    await field.setValue('fiesta')
    await field.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(adapter.rename).toHaveBeenCalledTimes(1)
    expect(adapter.rename).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }), 'fiesta')
    expect(wrapper.emitted('renamed')?.[0]?.[1]).toBe('fiesta')
    expect(h.announcer.polite).toHaveBeenCalledWith('Renamed :party: to :fiesta:')
    expect(document.activeElement).toBe(item(wrapper, 'e1').get('[data-action="rename"]').element)
  })

  it('keeps an invalid or refused name in the field with the reason', async () => {
    const wrapper = render()
    await item(wrapper, 'e2').get('[data-action="rename"]').trigger('click')
    await flushPromises()
    const field = wrapper.get('[data-testid="emoji-rename-input"]')
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    field.element.dispatchEvent(space)
    expect(space.defaultPrevented).toBe(false)
    await field.setValue('bad name')
    await field.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(adapter.rename).not.toHaveBeenCalled()
    expect(field.attributes('aria-invalid')).toBe('true')
    expect(document.getElementById(field.attributes('aria-describedby')!)?.textContent?.trim())
      .toBe('Names are 2 to 64 letters, digits, _ or -.')
    expect(h.announcer.assertive).toHaveBeenCalledWith('Names are 2 to 64 letters, digits, _ or -.')

    adapter.rename.mockRejectedValueOnce({ code: '23505' })
    adapter.describeError.mockReturnValueOnce('Name taken')
    await field.setValue('party')
    await field.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(adapter.describeError).toHaveBeenCalledWith('rename', { code: '23505' })
    expect(wrapper.get('[data-testid="emoji-rename-input"]').attributes('aria-invalid')).toBe('true')
    expect(h.announcer.assertive).toHaveBeenLastCalledWith('Name taken')
    expect(wrapper.emitted('renamed')).toBeUndefined()
  })

  it('deletes after confirmation and moves focus to the next row, then to the heading', async () => {
    const wrapper = render()
    h.confirm.mockResolvedValueOnce(false)
    await item(wrapper, 'e1').get('[data-action="delete"]').trigger('click')
    await flushPromises()
    expect(h.confirm.mock.calls[0][0]).toMatchObject({ message: 'Delete :party:?', dangerAction: true })
    expect(adapter.remove).not.toHaveBeenCalled()

    await item(wrapper, 'e1').get('[data-action="delete"]').trigger('click')
    await flushPromises()
    expect(adapter.remove).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }))
    expect(wrapper.emitted('deleted')?.[0]?.[0]).toEqual(['e1'])
    expect(h.announcer.polite).toHaveBeenCalledWith('Deleted :party:')
    expect(document.activeElement).toBe(item(wrapper, 'e2').get('[data-action="delete"]').element)

    await item(wrapper, 'e2').get('[data-action="delete"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Nothing here.')
    expect(document.activeElement?.textContent).toBe('Your emojis')
  })

  it('keeps the row when a delete fails', async () => {
    adapter.remove.mockRejectedValueOnce(new Error('down'))
    const wrapper = render()
    await item(wrapper, 'e1').get('[data-action="delete"]').trigger('click')
    await flushPromises()
    expect(h.toast.error).toHaveBeenCalledWith('Failed to delete emoji')
    expect(wrapper.findAll('[role="listitem"]')).toHaveLength(2)
  })

  it('bulk-deletes the selected emojis', async () => {
    const wrapper = render({ emojis: [emoji('e1', 'party'), emoji('e2', 'wave'), emoji('e3', 'cat')] })
    await wrapper.get('.header-right button').trigger('click')
    await flushPromises()
    const boxes = wrapper.findAll('[role="checkbox"]')
    expect(boxes).toHaveLength(3)
    expect(document.activeElement).toBe(boxes[0].element)
    await boxes[0].trigger('click')
    await boxes[2].trigger('keydown', { key: ' ' })
    expect(boxes[0].attributes('aria-checked')).toBe('true')

    await wrapper.get('[data-testid="emoji-bulk-delete"]').trigger('click')
    await flushPromises()
    expect(adapter.removeMany).toHaveBeenCalledWith([expect.objectContaining({ id: 'e1' }), expect.objectContaining({ id: 'e3' })])
    expect(wrapper.emitted('deleted')?.[0]?.[0]).toEqual(['e1', 'e3'])
    expect(h.toast.success).toHaveBeenCalledWith('2 emoji(s) deleted')
    expect(wrapper.findAll('[role="listitem"]')).toHaveLength(1)
  })

  it('copies the :name: shortcode', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const wrapper = render()
    await item(wrapper, 'e2').get('[data-action="copy"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(':wave:')
    expect(h.toast.success).toHaveBeenCalledWith('Copied :wave:')
  })
})
