/**
 * Appearance sync off: this device's look stands over the account copy, its other settings
 * still reach the account, and the account copy keeps its look. Turning sync on adopts the
 * account's look or writes this device's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const auth = vi.hoisted(() => ({ session: { user: { id: 'user-1' } } as null | { user: { id: string } } }))
const db = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  writes: 0,
  failRead: false,
}))

vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: null }) }))
vi.mock('@/services/AudioThemeService', () => ({
  audioThemeService: { getSettings: () => ({ selectedTheme: 'default' }), setTheme: vi.fn() },
}))
vi.mock('@/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (db.failRead
            ? { data: null, error: { message: 'unavailable' } }
            : { data: { appearance_settings: db.row }, error: null }),
        }),
      }),
      update: (patch: { appearance_settings: Record<string, unknown> }) => ({
        eq: async () => {
          db.row = patch.appearance_settings
          db.writes += 1
          return { error: null }
        },
      }),
    }),
  },
}))

async function load({ deviceOnly }: { deviceOnly: boolean }) {
  vi.resetModules()
  const { userStorage } = await import('@/utils/userScopedStorage')
  userStorage.setCurrentUser('user-1')
  if (deviceOnly) userStorage.setItem('appearance-sync', 'device')
  userStorage.setItem('visual-theme', JSON.stringify({
    theme: 'midnight', fontSize: 18, greentextEnabled: true, savedAt: 1,
  }))
  const { useVisualTheme } = await import('@/composables/useVisualTheme')
  const visualTheme = useVisualTheme()
  await visualTheme.initialize()
  await flushPromises()
  db.writes = 0
  return { visualTheme, userStorage }
}

const stored = (userStorage: { getItem: (k: string) => string | null }) =>
  JSON.parse(userStorage.getItem('visual-theme') ?? 'null')

beforeEach(() => {
  localStorage.clear()
  db.row = { theme: 'light', fontSize: 15, greentextEnabled: false, savedAt: 5 }
  db.writes = 0
  db.failRead = false
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
})

describe('appearance sync', () => {
  it('on: a newer account copy stands whole', async () => {
    const { visualTheme } = await load({ deviceOnly: false })
    expect(visualTheme.appearanceSynced.value).toBe(true)
    expect(visualTheme.settings.value).toMatchObject({ theme: 'light', fontSize: 15, greentextEnabled: false })
  })

  it('off: this device keeps its look and takes the account\'s other settings', async () => {
    const { visualTheme } = await load({ deviceOnly: true })
    expect(visualTheme.appearanceSynced.value).toBe(false)
    expect(visualTheme.settings.value).toMatchObject({ theme: 'midnight', fontSize: 18, greentextEnabled: false })
  })

  it('off: a change reaches the account under the account\'s look', async () => {
    const { visualTheme, userStorage } = await load({ deviceOnly: true })
    visualTheme.commitSettings({ ...visualTheme.settings.value, fontSize: 20, greentextEnabled: true })
    await flushPromises()
    expect(db.row).toMatchObject({ theme: 'light', fontSize: 15, greentextEnabled: true })
    expect(stored(userStorage)).toMatchObject({ theme: 'midnight', fontSize: 20, greentextEnabled: true })
  })

  it('off: an unreadable account copy is not overwritten', async () => {
    const { visualTheme } = await load({ deviceOnly: true })
    db.failRead = true
    visualTheme.commitSettings({ ...visualTheme.settings.value, greentextEnabled: true })
    await flushPromises()
    expect(db.writes).toBe(0)
    expect(db.row).toMatchObject({ greentextEnabled: false })
  })

  it('turning off changes nothing on screen', async () => {
    const { visualTheme, userStorage } = await load({ deviceOnly: false })
    await visualTheme.setAppearanceSynced(false)
    expect(visualTheme.appearanceSynced.value).toBe(false)
    expect(userStorage.getItem('appearance-sync')).toBe('device')
    expect(visualTheme.settings.value.theme).toBe('light')
  })

  it('turning on with the account\'s look switches this device to it', async () => {
    const { visualTheme, userStorage } = await load({ deviceOnly: true })
    await visualTheme.setAppearanceSynced(true, 'account')
    await flushPromises()
    expect(visualTheme.appearanceSynced.value).toBe(true)
    expect(userStorage.getItem('appearance-sync')).toBeNull()
    expect(visualTheme.settings.value).toMatchObject({ theme: 'light', fontSize: 15 })
  })

  it('turning on with this device\'s look writes it to the account', async () => {
    const { visualTheme } = await load({ deviceOnly: true })
    await visualTheme.setAppearanceSynced(true, 'device')
    await flushPromises()
    expect(visualTheme.settings.value.theme).toBe('midnight')
    expect(db.row).toMatchObject({ theme: 'midnight', fontSize: 18 })
  })
})
