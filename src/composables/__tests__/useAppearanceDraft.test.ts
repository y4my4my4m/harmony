import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'

const auth = vi.hoisted(() => ({ session: null as null | { user: { id: string } } }))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: null }) }))
vi.mock('@/services/AudioThemeService', () => ({
  audioThemeService: { getSettings: () => ({ selectedTheme: 'default' }), setTheme: vi.fn() },
}))

const root = document.documentElement
const inline = (name: string) => root.style.getPropertyValue(name).trim()

function stubColorScheme(light: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('light') ? light : !light,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

async function load(signedIn = true) {
  vi.resetModules()
  auth.session = signedIn ? { user: { id: 'user-1' } } : null
  const { userStorage } = await import('@/utils/userScopedStorage')
  if (signedIn) userStorage.setCurrentUser('user-1')
  else userStorage.clearCurrentUser()
  const { useVisualTheme } = await import('@/composables/useVisualTheme')
  const { useAppearanceDraft } = await import('@/composables/useAppearanceDraft')
  const visualTheme = useVisualTheme()
  await visualTheme.initialize()
  const scope = effectScope()
  const draft = scope.run(() => useAppearanceDraft())!
  return { visualTheme, draft, userStorage }
}

beforeEach(() => {
  localStorage.clear()
  root.removeAttribute('style')
  root.removeAttribute('data-theme')
  stubColorScheme(false)
})

describe('useAppearanceDraft', () => {
  it('keeps unsaved colour edits on screen when an override is added', async () => {
    const { visualTheme, draft } = await load()
    draft.setTheme('custom')
    draft.update({ customBackgroundLightness: 30 })
    await nextTick()
    const background = inline('--background-primary')
    expect(root.getAttribute('data-theme')).toBe('custom')

    draft.setCssOverride('--success', '#ff00ff')
    await nextTick()

    expect(inline('--success')).toBe('#ff00ff')
    expect(inline('--background-primary')).toBe(background)
    expect(root.getAttribute('data-theme')).toBe('custom')
    expect(visualTheme.settings.value.theme).toBe('dark')
    expect(visualTheme.settings.value.customCssOverrides).toEqual({})
  })

  it('stores every staged edit on save', async () => {
    const { visualTheme, draft } = await load()
    draft.setTheme('custom')
    draft.update({ customBackgroundLightness: 30, fontSize: 16 })
    draft.setCssOverride('--success', '#ff00ff')
    expect(draft.isDirty.value).toBe(true)

    draft.save()

    const stored = visualTheme.settings.value
    expect(stored.theme).toBe('custom')
    expect(stored.customBackgroundLightness).toBe(30)
    expect(stored.fontSize).toBe(16)
    expect(stored.customCssOverrides).toEqual({ '--success': '#ff00ff' })
    expect(draft.isDirty.value).toBe(false)
  })

  it('restores the stored look on discard', async () => {
    const { draft } = await load()
    draft.setTheme('custom')
    draft.setCssOverride('--success', '#ff00ff')
    await nextTick()

    draft.discard()
    await nextTick()

    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(inline('--success')).toBe('')
    expect(draft.isDirty.value).toBe(false)
  })

  it('clears the inline value of a removed override', async () => {
    const { draft } = await load()
    draft.setCssOverride('--tooltip-bg', '#123456')
    await nextTick()
    expect(inline('--tooltip-bg')).toBe('#123456')

    draft.removeCssOverride('--tooltip-bg')
    await nextTick()

    expect(inline('--tooltip-bg')).toBe('')
    expect(draft.isDirty.value).toBe(false)
  })

  it('drops overrides when switching between preset themes', async () => {
    const { draft } = await load()
    draft.setCssOverride('--success', '#ff00ff')
    draft.setTheme('light')
    expect(draft.draft.value.customCssOverrides).toEqual({})
  })
})

describe('useVisualTheme session handling', () => {
  it('follows a light system scheme while signed out and stores nothing', async () => {
    stubColorScheme(true)
    const { visualTheme } = await load(false)
    expect(visualTheme.settings.value.theme).toBe('light')
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(Object.keys(localStorage).some((k) => k.endsWith('visual-theme'))).toBe(false)
  })

  it('applies the stored theme when a user signs in without a reload', async () => {
    const { visualTheme, userStorage } = await load(false)
    expect(visualTheme.settings.value.theme).toBe('dark')

    auth.session = { user: { id: 'user-2' } }
    userStorage.setCurrentUser('user-2')
    userStorage.setItem('visual-theme', JSON.stringify({ theme: 'midnight' }))
    await visualTheme.initialize()

    expect(visualTheme.settings.value.theme).toBe('midnight')
    expect(root.getAttribute('data-theme')).toBe('midnight')
  })
})
