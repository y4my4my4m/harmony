import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { useI18n } from 'vue-i18n'
import ServerBasicInfo from '../ServerBasicInfo.vue'

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

const h = vi.hoisted(() => ({ cropImage: vi.fn() }))

vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ showToast: vi.fn() }) }))
vi.mock('@/utils/serverUtils', () => ({ getServerBannerUrl: (path: string) => `https://cdn.test/${path}` }))
vi.mock('@/utils/renderFallback', () => ({ withRenderFallback: (url: string) => url }))
vi.mock('@/utils/uploadValidation', () => ({ imageSourceError: () => null }))
vi.mock('@/composables/useImageCrop', () => ({ useImageCrop: () => ({ cropImage: h.cropImage }) }))
vi.mock('@/components/common/ServerIcon.vue', async () => {
  const { defineComponent, h: render } = await import('vue')
  return { default: defineComponent({ name: 'ServerIcon', props: { alt: String }, setup: (props) => () => render('img', { alt: props.alt }) }) }
})

enableAutoUnmount(afterEach)

const permissions = (canEdit: boolean) => ({
  canEditBasicInfo: canEdit,
  canChangeServerName: canEdit,
  canChangeServerDescription: canEdit,
  canChangeServerIcon: canEdit,
  canChangePrivacySettings: canEdit,
})

function mountInfo(banner = '', canEdit = true) {
  const { t } = useI18n()
  return mount(ServerBasicInfo, {
    attachTo: document.body,
    props: {
      server: { id: 's1', name: 'Lighthouse', description: 'Harbour', icon: 'icon.png', banner, rules: [] } as any,
      selectedFile: null,
      selectedBannerFile: null,
      ownerName: 'Ada',
      loading: false,
      permissions: permissions(canEdit),
    },
    global: { mocks: { $t: t } },
  })
}

const text = (ids: string | undefined) =>
  (ids ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ')

beforeEach(() => {
  document.body.innerHTML = ''
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  h.cropImage.mockReset()
})

describe('ServerBasicInfo uploads', () => {
  it('makes the banner upload a named, tabbable file input inside its label', () => {
    const wrapper = mountInfo()
    const input = wrapper.get('[data-testid="server-banner-input"]')
    const el = input.element as HTMLInputElement

    expect(el.type).toBe('file')
    expect(el.classList.contains('sr-only')).toBe(true)
    expect(el.closest('label')?.classList.contains('banner-preview')).toBe(true)
    expect(el.tabIndex).toBe(0)
    expect(el.getAttribute('aria-label')).toBe('Upload server banner')
    expect(text(el.getAttribute('aria-describedby') ?? undefined)).toContain('1280×400px')
    expect(text(el.closest('[role="group"]')?.getAttribute('aria-labelledby') ?? undefined)).toBe('Server banner')
  })

  it('names the banner input "Change server banner" when a banner is set', () => {
    const wrapper = mountInfo('banners/s1.webp')
    expect(wrapper.get('[data-testid="server-banner-input"]').attributes('aria-label')).toBe('Change server banner')
  })

  it('sends a picked banner through the cropper', async () => {
    const picked = new File(['x'], 'banner.png', { type: 'image/png' })
    const cropped = new File(['y'], 'banner.webp', { type: 'image/webp' })
    h.cropImage.mockResolvedValue(cropped)
    const wrapper = mountInfo()
    const input = wrapper.get('[data-testid="server-banner-input"]')
    Object.defineProperty(input.element, 'files', { value: [picked], configurable: true })

    await input.trigger('change')
    await flushPromises()

    expect(h.cropImage).toHaveBeenCalledWith(picked, 'server_banner')
    expect(wrapper.emitted('banner-change')?.[0]).toEqual([cropped])
  })

  it('renders no banner input for read-only members', () => {
    const wrapper = mountInfo('', false)
    expect(wrapper.find('[data-testid="server-banner-input"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No server banner set')
  })

  it('groups the server icon controls under their label', () => {
    const wrapper = mountInfo()
    const upload = wrapper.get('[data-testid="server-icon-upload"]')
    const group = upload.element.closest('[role="group"]')!
    expect(text(group.getAttribute('aria-labelledby') ?? undefined)).toBe('Server icon')
    expect(upload.text()).toBe('Upload image')
    expect(wrapper.get('img').attributes('alt')).toBe('Server icon')
  })

  it('describes the name and description fields with their hints', () => {
    const wrapper = mountInfo()
    expect(text(wrapper.get('#server-name').attributes('aria-describedby'))).toBe('This is how your server will appear to members')
    expect(text(wrapper.get('#server-description').attributes('aria-describedby'))).toBe('7/500 characters')
  })
})
