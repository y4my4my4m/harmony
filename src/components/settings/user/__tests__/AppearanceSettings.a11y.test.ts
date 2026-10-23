/**
 * Appearance settings for keyboard and screen-reader users: the theme cards are
 * one native radio group named "Theme", saved themes keep their delete button
 * outside the radio's label, the zoom buttons are named and the zoom value is
 * announced, disclosure headers expose aria-expanded, and the unsaved-changes
 * bar announces itself, then hands focus to the page heading on Save. Turning
 * appearance sync on asks which look stands and applies the choice on Save.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import en from '@/locales/en.json'
import AppearanceSettings from '../AppearanceSettings.vue'

const { polite, toast, current, savedThemes, sync } = vi.hoisted(() => ({
  sync: { synced: { value: true }, set: null as null | ((on: boolean, adopt?: string) => Promise<void>) },
  polite: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  current: { value: null as Record<string, unknown> | null },
  savedThemes: [] as Array<{ id: string; name: string; settings: Record<string, unknown> }>,
}))

const baseSettings = () => ({
  theme: 'dark',
  customThemeMode: 'dark',
  customPrimaryColor: '#0EA5E9',
  customAccentColor: '#0EA5E9',
  customBackgroundColor: '#0EA5E9',
  customBackgroundLightness: 0,
  customBackgroundChroma: 0,
  customCssOverrides: {},
  fontSize: 15,
  zoomLevel: 100,
  fontFamily: 'system',
  activeSkinId: null,
  showTimestamps: true,
  use24HourTime: false,
  compactMode: false,
  highContrast: false,
  reduceMotion: false,
  screenReaderSupport: false,
})

vi.mock('@/composables/useVisualTheme', () => {
  const clone = (s: unknown) => JSON.parse(JSON.stringify(s))
  return {
    COMMUNITY_PRESETS: [],
    BUILTIN_SKINS: [],
    cloneSettings: clone,
    settingsEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
    resolveSkin: clone,
    withPreset: clone,
    useVisualTheme: () => ({
      currentSettings: current,
      previewSettings: vi.fn(),
      commitSettings: (s: unknown) => {
        current.value = clone(s)
      },
      reapplySettings: vi.fn(),
      initialize: vi.fn(async () => {}),
      appearanceSynced: sync.synced,
      setAppearanceSynced: (on: boolean, adopt?: string) => sync.set!(on, adopt),
      getSavedCustomThemes: () => savedThemes,
      getThemableVariables: () => [],
      deleteSavedTheme: vi.fn(),
      saveCurrentThemeAsCustom: vi.fn(),
    }),
  }
})

vi.mock('@/composables/useAnnouncer', () => ({
  useAnnouncer: () => ({ polite, assertive: vi.fn(), announce: vi.fn() }),
  setVerboseAnnouncements: vi.fn(),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ back: vi.fn() }),
}))
vi.mock('@/components/EmojiPopup.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'EmojiPopupStub', render: () => h('div') }) }
})
vi.mock('@/composables/useFloatingVideo', () => ({
  useFloatingVideo: () => ({ isEnabled: ref(true), setEnabled: vi.fn() }),
}))
vi.mock('@/services/emojiPackService', () => ({
  useEmojiPacks: () => ({
    currentPackId: ref('native'),
    packs: ref([{ id: 'native', name: 'Native' }]),
    setCurrentPack: vi.fn(),
  }),
}))
vi.mock('@/composables/useQuickReactSettings', () => ({
  useQuickReactSettings: () => ({
    doubleClick: ref(false),
    doubleTap: ref(false),
    emoji: ref({ id: '👍', name: 'thumbsup', content: '👍' }),
    setEmoji: vi.fn(),
  }),
}))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ settings: { allowCustomEmojisInDisplayNames: false } }),
}))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

let wrapper: VueWrapper | null = null

async function mountPage() {
  wrapper = mount(AppearanceSettings, {
    props: { profile: null, loading: false },
    global: {
      plugins: [i18n],
      stubs: {
        ToggleSwitch: true,
        CssVarSwatch: true,
        ThemePaletteIdeas: true,
        EmojiPopup: true,
        Icon: true,
        ColorPicker: true,
      },
    },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

function accessibleName(el: Element): string {
  const ids = el.getAttribute('aria-labelledby')
  if (ids) return ids.split(' ').map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ')
  return el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''
}

beforeEach(() => {
  sync.synced.value = true
  sync.set = vi.fn(async (on: boolean) => { sync.synced.value = on })
  current.value = baseSettings()
  savedThemes.length = 0
  polite.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('AppearanceSettings theme cards', () => {
  it('form one native radio group named "Theme", radios named by theme', async () => {
    const w = await mountPage()
    const group = w.get('[data-testid="theme-options"]')
    expect(group.attributes('role')).toBe('radiogroup')
    expect(accessibleName(group.element)).toBe('Theme')

    const radios = group.findAll<HTMLInputElement>('input[type="radio"]')
    expect(radios.map((r) => accessibleName(r.element))).toEqual(['Dark', 'Light', 'Midnight', 'Custom'])
    // One shared name: the browser gives the set one Tab stop and arrow-key selection.
    expect(new Set(radios.map((r) => r.attributes('name'))).size).toBe(1)
    expect(radios.map((r) => r.element.checked)).toEqual([true, false, false, false])
    expect(document.getElementById(radios[1].attributes('aria-describedby')!)?.textContent).toBe('A clean, bright theme.')
  })

  it('a change on a radio (arrow key or click) selects that theme', async () => {
    const w = await mountPage()
    const radios = w.findAll<HTMLInputElement>('[data-testid="theme-options"] input[type="radio"]')
    radios[1].element.checked = true
    await radios[1].trigger('change')
    expect(radios[1].element.checked).toBe(true)
    expect(radios[0].element.checked).toBe(false)
    expect(w.get('[data-testid="theme-option-light"]').classes()).toContain('active')
    expect(w.get('[data-testid="theme-option-dark"]').classes()).not.toContain('active')
  })

  it('saved themes are radios in the same group; delete sits outside the label and is named', async () => {
    savedThemes.push({ id: 'ocean-1', name: 'Ocean', settings: { customBackgroundColor: '#123456' } })
    const w = await mountPage()
    const radios = w.findAll<HTMLInputElement>('[data-testid="theme-options"] input[type="radio"]')
    expect(radios).toHaveLength(5)
    expect(accessibleName(radios[4].element)).toBe('Ocean')
    expect(radios[4].attributes('name')).toBe(radios[0].attributes('name'))

    const del = w.get('.saved-theme-delete-btn')
    expect(del.attributes('aria-label')).toBe('Delete theme Ocean')
    expect(del.element.closest('label')).toBeNull()

    radios[4].element.checked = true
    await radios[4].trigger('change')
    // Applying a saved theme checks only its card, not "Custom" as well.
    expect(radios.map((r) => r.element.checked)).toEqual([false, false, false, false, true])

    await del.trigger('click')
    await flushPromises()
    const confirm = w.get('.delete-theme-confirm')
    expect(accessibleName(confirm.element)).toBe('Delete "Ocean"?')
    expect(document.activeElement).toBe(w.get('.cancel-delete-btn').element)
    await w.get('.cancel-delete-btn').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(del.element)
  })
})

describe('AppearanceSettings controls', () => {
  it('zoom buttons are named, describe the value and announce changes', async () => {
    const w = await mountPage()
    const out = w.get('[data-testid="zoom-out"]')
    const zin = w.get('[data-testid="zoom-in"]')
    expect(out.attributes('aria-label')).toBe('Zoom out')
    expect(zin.attributes('aria-label')).toBe('Zoom in')
    expect(document.getElementById(zin.attributes('aria-describedby')!)?.textContent).toBe('100%')
    expect(accessibleName(w.get('.zoom-controls').element)).toBe('Zoom level')

    await zin.trigger('click')
    expect(w.get('[data-testid="zoom-value"]').text()).toBe('110%')
    expect(polite).toHaveBeenCalledWith('Zoom 110%', expect.anything())
  })

  it('zoom keeps the button focusable at the limit (aria-disabled) and ignores presses', async () => {
    current.value = { ...baseSettings(), zoomLevel: 200 }
    const w = await mountPage()
    const zin = w.get('[data-testid="zoom-in"]')
    expect(zin.attributes('aria-disabled')).toBe('true')
    expect(zin.attributes('disabled')).toBeUndefined()
    polite.mockClear()
    await zin.trigger('click')
    expect(w.get('[data-testid="zoom-value"]').text()).toBe('200%')
    expect(polite).not.toHaveBeenCalledWith(expect.stringMatching(/^Zoom/), expect.anything())
  })

  it('custom theme: disclosure headers expose state, mode buttons aria-pressed, sliders labelled', async () => {
    current.value = { ...baseSettings(), theme: 'custom' }
    const w = await mountPage()
    const headers = w.findAll('.theme-collapse-header')
    expect(headers.length).toBe(4)
    for (const h of headers) {
      const controls = h.attributes('aria-controls')!
      expect(document.getElementById(controls)).not.toBeNull()
    }
    expect(headers.map((h) => h.attributes('aria-expanded'))).toEqual(['false', 'false', 'false', 'false'])
    await headers[0].trigger('click')
    expect(headers[0].attributes('aria-expanded')).toBe('true')

    const modes = w.findAll('.mode-btn')
    expect(modes.map((b) => [b.text(), b.attributes('aria-pressed')])).toEqual([
      ['Dark', 'true'],
      ['Light', 'false'],
    ])
    expect(accessibleName(w.get('.mode-options').element)).toBe('Theme mode')

    const lightness = w.get<HTMLInputElement>('input.lightness-slider')
    expect(w.get(`label[for="${lightness.attributes('id')}"]`).text()).toBe('Lightness')
    expect(lightness.attributes('aria-valuetext')).toBe('0')
    await lightness.setValue('10')
    expect(lightness.attributes('aria-valuetext')).toBe('+10, Lighter')
    const chroma = w.get<HTMLInputElement>('input.chroma-slider')
    expect(w.get(`label[for="${chroma.attributes('id')}"]`).text()).toBe('Saturation')
  })

  it('announces the unsaved bar once, and Save announces and moves focus to the heading', async () => {
    const w = await mountPage()
    await w.get('[data-testid="zoom-in"]').trigger('click')
    await w.get('[data-testid="zoom-in"]').trigger('click')
    const bar = w.get('[data-testid="appearance-save-bar"]')
    expect(polite.mock.calls.filter(([text]) => text === 'You have unsaved appearance changes')).toHaveLength(1)

    const save = bar.findAll('button').find((b) => b.text() === 'Save changes')!
    ;(save.element as HTMLElement).focus()
    await save.trigger('click')
    await flushPromises()
    expect(polite).toHaveBeenCalledWith('Appearance saved')
    expect(document.activeElement).toBe(w.get('h2.settings-title').element)
    expect(w.find('[data-testid="appearance-save-bar"]').exists()).toBe(false)
  })

  it('Reset announces and keeps focus on the heading', async () => {
    const w = await mountPage()
    await w.get('[data-testid="zoom-in"]').trigger('click')
    const reset = w.get('[data-testid="appearance-save-bar"]').findAll('button').find((b) => b.text() === 'Reset')!
    ;(reset.element as HTMLElement).focus()
    await reset.trigger('click')
    await flushPromises()
    expect(polite).toHaveBeenCalledWith('Appearance changes reset')
    expect(document.activeElement).toBe(w.get('h2.settings-title').element)
    expect(w.get('[data-testid="zoom-value"]').text()).toBe('100%')
  })
})

describe('AppearanceSettings appearance sync', () => {
  it('asks which look stands only while sync is turned on, and applies it on Save', async () => {
    sync.synced.value = false
    const w = await mountPage()
    expect(w.find('[data-testid="appearance-sync-adopt"]').exists()).toBe(false)

    w.getComponent('[data-testid="appearance-sync-toggle"]').vm.$emit('update:modelValue', true)
    await flushPromises()
    const adopt = w.get('[data-testid="appearance-sync-adopt"]')
    expect(adopt.element.tagName).toBe('FIELDSET')
    const radios = adopt.findAll('input[type="radio"]')
    expect(radios.map((r) => (r.element as HTMLInputElement).checked)).toEqual([true, false])
    await radios[1].setValue(true)

    const save = w.get('[data-testid="appearance-save-bar"]').findAll('button').find((b) => b.text() === 'Save changes')!
    await save.trigger('click')
    await flushPromises()
    expect(sync.set).toHaveBeenCalledWith(true, 'device')
    expect(w.find('[data-testid="appearance-sync-adopt"]').exists()).toBe(false)
  })

  it('turning sync off asks nothing', async () => {
    const w = await mountPage()
    w.getComponent('[data-testid="appearance-sync-toggle"]').vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(w.find('[data-testid="appearance-sync-adopt"]').exists()).toBe(false)
    const save = w.get('[data-testid="appearance-save-bar"]').findAll('button').find((b) => b.text() === 'Save changes')!
    await save.trigger('click')
    await flushPromises()
    expect(sync.set).toHaveBeenCalledWith(false, 'account')
  })
})
