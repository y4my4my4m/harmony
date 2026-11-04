import { describe, it, expect, vi, beforeEach } from 'vitest'

// The sound theme volume of a new account is 100 %. Builds before settings version 2 stored 0.7
// with every theme change; that reads as 100 %, any other stored level is kept.

vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const KEY = 'audio_theme_settings'
const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
}))

beforeEach(() => {
  storage.clear()
  vi.resetModules()
})

async function serviceWith(stored: unknown) {
  if (stored !== undefined) storage.set(KEY, JSON.stringify(stored))
  return import('../AudioThemeService')
}

describe('migrateAudioThemeSettings', () => {
  it('moves an untouched v1 default to 1 and stamps the version', async () => {
    const { migrateAudioThemeSettings } = await serviceWith(undefined)
    const stored: Record<string, unknown> = { volume: 0.7 }
    expect(migrateAudioThemeSettings(stored)).toBe(true)
    expect(stored).toEqual({ volume: 1, settingsVersion: 2 })
  })

  it('keeps a level the user set in v1', async () => {
    const { migrateAudioThemeSettings } = await serviceWith(undefined)
    const stored: Record<string, unknown> = { volume: 0.55 }
    expect(migrateAudioThemeSettings(stored)).toBe(true)
    expect(stored).toEqual({ volume: 0.55, settingsVersion: 2 })
  })

  it('leaves version 2 alone, 0.7 included', async () => {
    const { migrateAudioThemeSettings } = await serviceWith(undefined)
    const stored: Record<string, unknown> = { volume: 0.7, settingsVersion: 2 }
    expect(migrateAudioThemeSettings(stored)).toBe(false)
    expect(stored.volume).toBe(0.7)
  })
})

describe('AudioThemeService volume', () => {
  it('starts a new account at 1', async () => {
    const { audioThemeService } = await serviceWith(undefined)
    expect(audioThemeService.getVolume()).toBe(1)
  })

  it('reads a v1 0.7 as 1 and stores the upgrade', async () => {
    const { audioThemeService } = await serviceWith({ selectedTheme: 'default', volume: 0.7, lastUpdated: 'x' })
    expect(audioThemeService.getVolume()).toBe(1)
    expect(JSON.parse(storage.get(KEY)!)).toMatchObject({ volume: 1, settingsVersion: 2 })
  })

  it('keeps a stored level and a chosen 0.7 once versioned', async () => {
    const kept = await serviceWith({ selectedTheme: 'default', volume: 0.4, lastUpdated: 'x' })
    expect(kept.audioThemeService.getVolume()).toBe(0.4)
    vi.resetModules()
    storage.clear()
    const chosen = await serviceWith({ selectedTheme: 'default', volume: 0.7, lastUpdated: 'x', settingsVersion: 2 })
    expect(chosen.audioThemeService.getVolume()).toBe(0.7)
  })

  it('writes the version with every save', async () => {
    const { audioThemeService } = await serviceWith(undefined)
    audioThemeService.setVolume(0.7)
    expect(JSON.parse(storage.get(KEY)!)).toMatchObject({ volume: 0.7, settingsVersion: 2 })
  })
})
