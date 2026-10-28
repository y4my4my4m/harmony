/**
 * Sticker management shared by Server settings, Admin and User settings: a cap of 0 shows the
 * scope's notice instead of the form, the form requires a description, and refusals are shown
 * where the file was picked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    return typeof message === 'string'
      ? message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
      : key
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t }) }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
const confirm = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm }) }))
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => ({ polite: vi.fn() }) }))
vi.mock('@/supabase', () => ({ supabase: {} }))

import StickerLibraryManager from '../StickerLibraryManager.vue'
import type { StickerLibraryAdapter } from '../stickerLibrary'

const sticker = (over: Record<string, unknown> = {}) => ({
  id: 's1', scope: 'server', server_id: 'srv', owner_id: null, uploader: 'me', name: 'Cat wave',
  description: 'A cat waving', url: 'https://h.test/s.png', path: 'server/srv/x.png', mime_type: 'image/png',
  file_size: 10, width: 10, height: 10, duration_ms: null, created_at: '2026-10-27T00:00:00Z', ...over,
})

function adapter(): StickerLibraryAdapter & { [k: string]: any } {
  return {
    upload: vi.fn(async (_f, name, description) => sticker({ id: 's2', name, description }) as any),
    update: vi.fn(async (s, changes) => ({ ...s, ...changes })),
    remove: vi.fn(async () => {}),
  }
}

function mountManager(props: Record<string, unknown> = {}) {
  return mount(StickerLibraryManager, {
    props: {
      stickers: [sticker()],
      adapter: adapter(),
      max: 15,
      canManage: true,
      title: 'Stickers',
      offNotice: 'Server stickers are turned off on this instance.',
      testId: 'server-sticker-library',
      ...props,
    },
  })
}

beforeEach(() => vi.clearAllMocks())

describe('StickerLibraryManager', () => {
  it('counts against the cap and lists each sticker with its description', () => {
    const wrapper = mountManager()
    expect(wrapper.get('[data-testid="sticker-count"]').text()).toBe('1 / 15')
    expect(wrapper.get('[data-testid="sticker-row"] img').attributes('alt')).toBe('A cat waving')
  })

  it('shows the off notice and no form when the cap is 0', () => {
    const wrapper = mountManager({ max: 0 })
    expect(wrapper.find('[data-testid="sticker-upload-form"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sticker-uploads-off"]').text()).toBe('Server stickers are turned off on this instance.')
  })

  it('shows the cap notice instead of the file field at the cap', () => {
    const wrapper = mountManager({ max: 1 })
    expect(wrapper.find('[data-testid="sticker-upload-input"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="sticker-cap-reached"]').text()).toBe('Sticker limit reached (1).')
  })

  it('uploads with the name from the file and the typed description', async () => {
    const a = adapter()
    const wrapper = mountManager({ adapter: a })
    const input = wrapper.get('[data-testid="sticker-upload-input"]')
    const picked = new File([new Uint8Array(4)], 'party_cat.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [picked] })
    globalThis.URL.createObjectURL ??= () => 'blob:x'
    globalThis.URL.revokeObjectURL ??= () => {}
    await input.trigger('change')
    expect((wrapper.get('[data-testid="sticker-name-input"]').element as HTMLInputElement).value).toBe('party cat')
    await wrapper.get('[data-testid="sticker-description-input"]').setValue('A cat at a party')
    await wrapper.get('[data-testid="sticker-upload-form"]').trigger('submit')
    await flushPromises()
    expect(a.upload).toHaveBeenCalledWith(picked, 'party cat', 'A cat at a party', expect.any(Function))
    expect(wrapper.emitted('uploaded')).toHaveLength(1)
  })

  it('shows a refusal beside the form', async () => {
    const a = adapter()
    a.upload.mockRejectedValue({ code: '23514', message: 'STICKER_LIMIT: at most 15 server stickers' })
    const wrapper = mountManager({ adapter: a })
    const input = wrapper.get('[data-testid="sticker-upload-input"]')
    Object.defineProperty(input.element, 'files', { value: [new File([new Uint8Array(4)], 'a.png', { type: 'image/png' })] })
    globalThis.URL.createObjectURL ??= () => 'blob:x'
    await input.trigger('change')
    await wrapper.get('[data-testid="sticker-description-input"]').setValue('x')
    await wrapper.get('[data-testid="sticker-upload-form"]').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-testid="sticker-upload-error"]').text()).toBe('Sticker limit reached (15).')
  })

  it('hides management controls from a reader', () => {
    const wrapper = mountManager({ canManage: false })
    expect(wrapper.find('[data-testid="sticker-upload-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sticker-delete"]').exists()).toBe(false)
  })
})
