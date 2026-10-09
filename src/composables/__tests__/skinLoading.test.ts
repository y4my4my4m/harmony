import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'

const auth = vi.hoisted(() => ({ session: null as null | { user: { id: string } } }))
const sheets = vi.hoisted(() => ({
  resolvers: {} as Record<string, (css: string) => void>,
  calls: [] as string[],
}))
const scenes = vi.hoisted(() => ({
  resolvers: {} as Record<string, () => void>,
  log: [] as string[],
}))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: null }) }))
vi.mock('@/services/AudioThemeService', () => ({
  audioThemeService: { getSettings: () => ({ selectedTheme: 'default' }), setTheme: vi.fn() },
}))
vi.mock('@/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
}))
vi.mock('@/composables/skins', () => {
  const skin = (id: string, withScene = false) => ({
    id,
    name: id,
    description: id,
    themeOverrides: {},
    options: [{ id: 'glow', label: 'Glow', type: 'boolean', default: true }],
    loadCss: () => {
      sheets.calls.push(id)
      return new Promise<string>((resolve) => {
        sheets.resolvers[id] = resolve
      })
    },
    ...(withScene
      ? {
          loadScene: () => {
            scenes.log.push(`load:${id}`)
            return new Promise((resolve) => {
              scenes.resolvers[id] = () =>
                resolve(() => ({
                  update: (o: Record<string, boolean>) => scenes.log.push(`update:${id}:${JSON.stringify(o)}`),
                  destroy: () => scenes.log.push(`destroy:${id}`),
                }))
            })
          },
        }
      : {}),
  })
  return { BUILTIN_SKINS: [skin('alpha'), skin('beta'), skin('gamma-scene', true), skin('delta-scene', true)] }
})

const sheet = () => document.getElementById('harmony-skin-styles')?.textContent ?? null
const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await nextTick()
}

async function load(stored?: Record<string, unknown>) {
  vi.resetModules()
  auth.session = { user: { id: 'user-1' } }
  const { userStorage } = await import('@/utils/userScopedStorage')
  userStorage.setCurrentUser('user-1')
  if (stored) userStorage.setItem('visual-theme', JSON.stringify(stored))
  const mod = await import('@/composables/useVisualTheme')
  const visualTheme = mod.useVisualTheme()
  await visualTheme.initialize()
  return { visualTheme, userStorage }
}

beforeEach(() => {
  localStorage.clear()
  document.getElementById('harmony-skin-styles')?.remove()
  document.documentElement.removeAttribute('data-skin')
  sheets.resolvers = {}
  sheets.calls = []
  scenes.resolvers = {}
  scenes.log = []
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
})

describe('skin stylesheets', () => {
  it('fetches nothing while no skin is active', async () => {
    await load()
    expect(sheets.calls).toEqual([])
    expect(sheet()).toBeNull()
  })

  it('fetches only the active skin and writes it once it arrives', async () => {
    const { visualTheme } = await load()
    visualTheme.applySkin('alpha')
    await flush()
    expect(sheets.calls).toEqual(['alpha'])
    expect(document.documentElement.getAttribute('data-skin')).toBe('alpha')
    expect(sheet()).toBeNull()
    sheets.resolvers.alpha(':root[data-skin="alpha"] {}')
    await flush()
    expect(sheet()).toBe(':root[data-skin="alpha"] {}')
  })

  it('drops a sheet that arrives after the user moved to another skin', async () => {
    const { visualTheme } = await load()
    visualTheme.applySkin('alpha')
    await flush()
    visualTheme.applySkin('beta')
    await flush()
    sheets.resolvers.alpha('alpha-css')
    await flush()
    expect(sheet()).toBeNull()
    sheets.resolvers.beta('beta-css')
    await flush()
    expect(sheet()).toBe('beta-css')
  })

  it('reuses a loaded sheet without fetching again', async () => {
    const { visualTheme } = await load()
    visualTheme.applySkin('alpha')
    await flush()
    sheets.resolvers.alpha('alpha-css')
    await flush()
    visualTheme.applySkin(null)
    await flush()
    expect(sheet()).toBeNull()
    visualTheme.applySkin('alpha')
    await flush()
    expect(sheet()).toBe('alpha-css')
    expect(sheets.calls).toEqual(['alpha'])
  })

  it('never stores a built-in sheet and clears one stored by an older build', async () => {
    const { visualTheme, userStorage } = await load({
      theme: 'custom',
      activeSkinId: 'alpha',
      customSkinCss: 'x'.repeat(40000),
    })
    expect(visualTheme.currentSettings.value.customSkinCss).toBe('')
    visualTheme.applySkin('beta')
    await flush()
    expect(visualTheme.currentSettings.value.customSkinCss).toBe('')
    const persisted = JSON.parse(userStorage.getItem('visual-theme') || '{}')
    expect(persisted.customSkinCss ?? '').toBe('')
  })

  it('keeps a stored sheet for a skin id this build does not ship', async () => {
    await load({ theme: 'custom', activeSkinId: 'gamma', customSkinCss: ':root[data-skin="gamma"] {}' })
    await flush()
    expect(sheets.calls).toEqual([])
    expect(sheet()).toBe(':root[data-skin="gamma"] {}')
  })
})

describe('skin scenes', () => {
  it('loads a scene only for a skin that declares one', async () => {
    const { visualTheme } = await load()
    visualTheme.applySkin('alpha')
    await flush()
    expect(scenes.log).toEqual([])
    visualTheme.applySkin('gamma-scene')
    await flush()
    expect(scenes.log).toEqual(['load:gamma-scene'])
  })

  it('mounts with the current options and passes later option changes through update', async () => {
    const { visualTheme } = await load()
    visualTheme.applySkin('gamma-scene')
    await flush()
    visualTheme.setSkinOption('gamma-scene', 'glow', false)
    await flush()
    scenes.resolvers['gamma-scene']()
    await flush()
    expect(scenes.log).toEqual(['load:gamma-scene', 'update:gamma-scene:{"glow":false}'])
    visualTheme.setSkinOption('gamma-scene', 'glow', true)
    await flush()
    expect(scenes.log.at(-1)).toBe('update:gamma-scene:{"glow":true}')
  })

  it('destroys the scene when the skin changes or clears', async () => {
    const { visualTheme } = await load()
    visualTheme.applySkin('gamma-scene')
    await flush()
    scenes.resolvers['gamma-scene']()
    await flush()
    visualTheme.applySkin('alpha')
    await flush()
    expect(scenes.log).toContain('destroy:gamma-scene')
    visualTheme.applySkin('delta-scene')
    await flush()
    scenes.resolvers['delta-scene']()
    await flush()
    visualTheme.applySkin(null)
    await flush()
    expect(scenes.log.at(-1)).toBe('destroy:delta-scene')
  })

  it('never mounts a scene whose skin was left before it loaded', async () => {
    const { visualTheme } = await load()
    visualTheme.applySkin('gamma-scene')
    await flush()
    visualTheme.applySkin('delta-scene')
    await flush()
    scenes.resolvers['gamma-scene']()
    scenes.resolvers['delta-scene']()
    await flush()
    expect(scenes.log.filter((l) => l.startsWith('update:'))).toEqual(['update:delta-scene:{"glow":true}'])
  })
})
