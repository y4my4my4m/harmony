import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import SettingsBuildFooter from '../SettingsBuildFooter.vue'

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  getVersion: vi.fn(async () => '1.6.6'),
  platform: 'web' as string,
  settings: { termsUrl: '', privacyUrl: '' },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => mocks.toast }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.getVersion }))
vi.mock('@/utils/platform', () => ({ getAppPlatform: () => mocks.platform }))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => reactive({ settings: mocks.settings }),
}))

const writeText = vi.fn(async () => {})

function mountFooter() {
  return mount(SettingsBuildFooter, { global: { mocks: { $t: (k: string) => k } } })
}

beforeEach(() => {
  vi.stubGlobal('__APP_VERSION__', '1.6.7')
  vi.stubGlobal('__APP_COMMIT__', '8b288a24')
  vi.stubGlobal('__APP_BUILD_DATE__', '2026-10-08T00:00:00.000Z')
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, version: '1.6.5' }) })))
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  mocks.platform = 'web'
  mocks.settings.termsUrl = ''
  mocks.settings.privacyUrl = ''
  writeText.mockClear()
  mocks.toast.success.mockClear()
  mocks.toast.error.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as any).__TAURI_INTERNALS__
})

describe('SettingsBuildFooter', () => {
  it('shows version, commit and platform on web', async () => {
    const w = mountFooter()
    await flushPromises()
    expect(w.get('[data-testid="build-line"]').text()).toBe('1.6.7 (8b288a24) · web')
  })

  it('shows the native version under Tauri when it differs', async () => {
    ;(globalThis as any).__TAURI_INTERNALS__ = {}
    mocks.platform = 'tauri-mobile'
    const w = mountFooter()
    await flushPromises()
    expect(w.get('[data-testid="build-line"]').text()).toBe('1.6.7 (8b288a24) · android · app 1.6.6')
  })

  it('omits the commit when the build has none', async () => {
    vi.stubGlobal('__APP_COMMIT__', '')
    const w = mountFooter()
    await flushPromises()
    expect(w.get('[data-testid="build-line"]').text()).toBe('1.6.7 · web')
  })

  it('copies the support block and toasts', async () => {
    const w = mountFooter()
    await w.get('[data-testid="build-line"]').trigger('click')
    await flushPromises()
    const text = writeText.mock.calls[0][0] as string
    expect(text).toContain('Version: 1.6.7')
    expect(text).toContain('Commit: 8b288a24')
    expect(text).toContain('Platform: web')
    expect(text).toContain('Instance: harmony.test')
    expect(text).toContain('Server version: 1.6.5')
    expect(mocks.toast.success).toHaveBeenCalledWith('settings.buildInfo.copied')
  })

  it('toasts an error when the clipboard refuses', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const w = mountFooter()
    await w.get('[data-testid="build-line"]').trigger('click')
    await flushPromises()
    expect(mocks.toast.error).toHaveBeenCalledWith('settings.buildInfo.copyFailed')
  })

  it('prefers instance legal URLs over the defaults', async () => {
    let links = mountFooter().findAll('.legal-links a').map(a => a.attributes('href'))
    expect(links).toEqual(['https://mony.lol/terms', 'https://mony.lol/privacy-policy'])
    mocks.settings.termsUrl = 'https://example.org/tos'
    mocks.settings.privacyUrl = 'https://example.org/privacy'
    links = mountFooter().findAll('.legal-links a').map(a => a.attributes('href'))
    expect(links).toEqual(['https://example.org/tos', 'https://example.org/privacy'])
  })
})
