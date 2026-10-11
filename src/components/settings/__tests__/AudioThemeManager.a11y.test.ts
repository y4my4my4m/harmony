/**
 * Audio theme cards are one native radio group named "Audio themes"; the
 * preview buttons sit outside each radio's label and name their theme; the mute
 * button is a named toggle and the volume slider is labelled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import AudioThemeManager from '../AudioThemeManager.vue'

const { store } = vi.hoisted(() => ({ store: {} as Record<string, any> }))

vi.mock('@/stores/useTheme', async () => {
  const { reactive } = await import('vue')
  const themes = [
    { id: 'default', name: 'Default', description: 'Classic sounds', author: 'Harmony', version: '1.0', isBuiltIn: true },
    { id: 'futuristic', name: 'Futuristic', description: 'Synth blips', author: 'Harmony', version: '1.0', isBuiltIn: true },
    { id: 'flux', name: 'Flux', description: 'Water drops', author: 'Harmony', version: '1.0', isBuiltIn: true },
  ]
  Object.assign(store, reactive({
    isInitialized: true,
    isReady: true,
    currentAudioTheme: 'default',
    audioThemes: themes,
    audioVolume: 0.7,
    preloadingTheme: null,
    systemStatus: 'ready',
    lastError: null,
    get getCurrentAudioTheme() {
      return themes.find((t) => t.id === this.currentAudioTheme)
    },
    getCacheInfo: () => ({ size: 1, maxSize: 10, loadedThemes: [] }),
    setAudioTheme: vi.fn(),
    setAudioVolume: vi.fn(),
    testAudio: vi.fn(async () => {}),
    preloadTheme: vi.fn(async () => {}),
    initialize: vi.fn(async () => {}),
    clearError: vi.fn(),
  }))
  return { useThemeStore: () => store }
})
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ showToast: vi.fn() }) }))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

let wrapper: VueWrapper | null = null

async function mountManager() {
  wrapper = mount(AudioThemeManager, {
    global: { plugins: [i18n], stubs: { Icon: true } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

function nameOf(el: Element): string {
  const ids = el.getAttribute('aria-labelledby')
  if (ids) return ids.split(' ').map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ')
  return el.getAttribute('aria-label') ?? ''
}

beforeEach(() => {
  store.currentAudioTheme = 'default'
  store.setAudioTheme.mockReset()
  store.setAudioTheme.mockImplementation(async (id: string) => {
    store.currentAudioTheme = id
    return true
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('AudioThemeManager', () => {
  it('theme cards are one native radio group named by the section heading', async () => {
    const w = await mountManager()
    const group = w.get('[data-testid="audio-theme-options"]')
    expect(group.attributes('role')).toBe('radiogroup')
    expect(nameOf(group.element)).toBe('Audio themes')
    const radios = group.findAll<HTMLInputElement>('input[type="radio"]')
    expect(radios.map((r) => nameOf(r.element))).toEqual(['Default', 'Flux', 'Futuristic'])
    expect(new Set(radios.map((r) => r.attributes('name'))).size).toBe(1)
    expect(radios.map((r) => r.element.checked)).toEqual([true, false, false])
  })

  it('a change on a radio switches the theme and emits themeChanged', async () => {
    const w = await mountManager()
    const radios = w.findAll<HTMLInputElement>('[data-testid="audio-theme-options"] input[type="radio"]')
    await radios[2].setValue(true)
    await flushPromises()
    expect(store.setAudioTheme).toHaveBeenCalledWith('futuristic')
    expect(w.emitted('themeChanged')).toEqual([['futuristic']])
    expect(radios.map((r) => r.element.checked)).toEqual([false, false, true])
    expect(w.get('[data-testid="audio-theme-option-futuristic"]').classes()).toContain('active')
  })

  it('a failed switch puts the checked radio back on the current theme', async () => {
    store.setAudioTheme.mockImplementation(async () => false)
    const w = await mountManager()
    const radios = w.findAll<HTMLInputElement>('[data-testid="audio-theme-options"] input[type="radio"]')
    await radios[1].setValue(true)
    await flushPromises()
    expect(radios.map((r) => r.element.checked)).toEqual([true, false, false])
    expect(w.emitted('themeChanged')).toBeUndefined()
  })

  it('a choice made while a theme loads is applied after it', async () => {
    let finish: (ok: boolean) => void = () => {}
    store.setAudioTheme.mockImplementationOnce(
      (id: string) =>
        new Promise<boolean>((resolve) => {
          finish = (ok) => {
            store.currentAudioTheme = id
            resolve(ok)
          }
        }),
    )
    const w = await mountManager()
    const radios = w.findAll<HTMLInputElement>('[data-testid="audio-theme-options"] input[type="radio"]')
    await radios[1].setValue(true)
    await radios[2].setValue(true)
    expect(store.setAudioTheme).toHaveBeenCalledTimes(1)
    finish(true)
    await flushPromises()
    expect(store.setAudioTheme).toHaveBeenLastCalledWith('futuristic')
    expect(store.currentAudioTheme).toBe('futuristic')
    expect(radios.map((r) => r.element.checked)).toEqual([false, false, true])
  })

  it('preview buttons name their theme and sit outside the radio labels', async () => {
    const w = await mountManager()
    const preview = w.get('[data-testid="audio-theme-preview-flux"]')
    expect(preview.attributes('aria-label')).toBe('Play Flux preview')
    expect(preview.element.closest('label')).toBeNull()
    expect(w.get('[data-testid="audio-theme-test-current"]').attributes('aria-label')).toBe('Play Default preview')
  })

  it('mute is a named toggle; the volume slider is labelled with a percent value', async () => {
    const w = await mountManager()
    const mute = w.get('[data-testid="audio-theme-mute"]')
    expect(mute.attributes('aria-label')).toBe('Mute sounds')
    expect(mute.attributes('aria-pressed')).toBe('false')
    await mute.trigger('click')
    expect(mute.attributes('aria-pressed')).toBe('true')

    const slider = w.get('input.volume-slider')
    expect(w.get(`label[for="${slider.attributes('id')}"]`).text()).toBe('Master volume')
    expect(slider.attributes('aria-valuetext')).toBe('0%')
  })
})
