/**
 * Live theme editor panel: a non-modal dialog labelled by its heading, on a
 * popover layer. Focus moves in on open, Escape with focus inside cancels and
 * closes only the panel, focus returns to the opener (or the main landmark once
 * the opener is gone).
 * Disclosure headers expose aria-expanded; no control nests inside a button.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'
import en from '@/locales/en.json'
import ThemeCustomizerPanel from '../ThemeCustomizerPanel.vue'
import { useThemeEditorPanel } from '@/composables/useThemeEditorPanel'
import { hasOpenLayer } from '@/utils/a11y/layers'

const { current, updateSettings } = vi.hoisted(() => ({
  current: { value: null as Record<string, unknown> | null },
  updateSettings: vi.fn(),
}))

vi.mock('@/composables/useVisualTheme', () => ({
  cloneSettings: (s: unknown) => JSON.parse(JSON.stringify(s)),
  useVisualTheme: () => ({
    currentSettings: current,
    getThemableVariables: () => [{ category: 'Surfaces', vars: ['--background-primary'] }],
    updateSettings,
    reapplySettings: vi.fn(),
  }),
}))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const panel = useThemeEditorPanel()

let wrapper: VueWrapper | null = null
let opener: HTMLButtonElement
let main: HTMLElement

async function openPanel() {
  wrapper = mount(ThemeCustomizerPanel, {
    global: { plugins: [i18n], stubs: { ThemePaletteIdeas: true, CssVarSwatch: true } },
    attachTo: document.body,
  })
  opener.focus()
  panel.open()
  await nextTick()
  await flushPromises()
  return document.querySelector<HTMLElement>('[data-testid="theme-editor-panel"]')!
}

function escape(target: Element) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

beforeEach(() => {
  current.value = {
    theme: 'custom',
    customThemeMode: 'dark',
    customBackgroundColor: '#0EA5E9',
    customPrimaryColor: '#0EA5E9',
    customAccentColor: '#0EA5E9',
    customCssOverrides: {},
  }
  updateSettings.mockClear()
  main = document.createElement('main')
  main.id = 'main-content'
  main.tabIndex = -1
  opener = document.createElement('button')
  opener.textContent = 'Edit on live preview'
  main.appendChild(opener)
  document.body.appendChild(main)
})

afterEach(async () => {
  panel.close()
  await nextTick()
  wrapper?.unmount()
  wrapper = null
  main.remove()
})

describe('ThemeCustomizerPanel', () => {
  it('is a non-modal dialog labelled and described, and focus moves into it', async () => {
    const el = await openPanel()
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.hasAttribute('aria-modal')).toBe(false)
    expect(document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent).toBe('Customize your theme')
    expect(document.getElementById(el.getAttribute('aria-describedby')!)?.textContent).toMatch(/Click Apply to keep them/)
    expect(el.contains(document.activeElement)).toBe(true)
    // Non-modal: the page behind is not made inert.
    expect(main.hasAttribute('inert')).toBe(false)
    expect(el.querySelector('[data-testid="theme-editor-close"]')?.getAttribute('aria-label')).toBe('Close theme editor')
  })

  it('Escape inside the panel cancels, closes it and returns focus to the opener', async () => {
    const el = await openPanel()
    escape(document.activeElement ?? el)
    await nextTick()
    await flushPromises()
    expect(panel.isOpen.value).toBe(false)
    expect(document.querySelector('[data-testid="theme-editor-panel"]')).toBeNull()
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(opener)
  })

  it('focus goes to the main landmark when the opener has unmounted', async () => {
    await openPanel()
    opener.remove()
    ;(document.querySelector('[data-testid="theme-editor-close"]') as HTMLElement).click()
    await nextTick()
    await flushPromises()
    expect(panel.isOpen.value).toBe(false)
    expect(document.activeElement).toBe(main)
  })

  it('registers no dialog layer, so F6 region cycling stays on while it is open', async () => {
    await openPanel()
    expect(hasOpenLayer('dialog')).toBe(false)
    expect(hasOpenLayer('popover')).toBe(true)
    panel.close()
    await nextTick()
    await flushPromises()
    expect(hasOpenLayer('popover')).toBe(false)
  })

  it('Escape with focus outside the panel leaves it open', async () => {
    await openPanel()
    const outside = document.createElement('button')
    main.appendChild(outside)
    outside.focus()
    escape(outside)
    await nextTick()
    expect(panel.isOpen.value).toBe(true)
  })

  it('disclosure headers expose state; mode buttons are toggles; sliders are labelled', async () => {
    const el = await openPanel()
    const headers = Array.from(el.querySelectorAll<HTMLButtonElement>('.tp-collapse-header'))
    expect(headers.map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false', 'false', 'false'])
    for (const h of headers) expect(document.getElementById(h.getAttribute('aria-controls')!)).not.toBeNull()
    headers[3].click()
    await nextTick()
    expect(headers[3].getAttribute('aria-expanded')).toBe('true')

    const modes = Array.from(el.querySelectorAll<HTMLButtonElement>('.tp-mode-btn'))
    expect(modes.map((b) => [b.textContent?.trim(), b.getAttribute('aria-pressed')])).toEqual([
      ['Dark', 'true'],
      ['Light', 'false'],
    ])
    modes[1].click()
    await nextTick()
    expect(modes[1].getAttribute('aria-pressed')).toBe('true')

    const range = el.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(el.querySelector(`label[for="${range.id}"]`)?.textContent).toBe('Lightness')
    expect(range.getAttribute('aria-valuetext')).toBe('0')
  })

  it('the sidebar checkbox is not nested in a button and is labelled', async () => {
    const el = await openPanel()
    expect(el.querySelectorAll('button input, button [role="checkbox"], button button').length).toBe(0)
    const box = el.querySelector<HTMLInputElement>('[data-testid="theme-editor-sidebar-toggle"]')!
    expect(box.closest('label')?.textContent).toMatch('Use a separate sidebar color')
    box.click()
    await nextTick()
    expect(el.querySelectorAll('.tp-collapse-body [role="group"][aria-label="Sidebar color"]').length).toBe(1)
  })
})
