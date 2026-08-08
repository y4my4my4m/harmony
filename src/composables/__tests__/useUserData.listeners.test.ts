// Service listeners bind once at module scope, not per useUserData() call.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const addEventListener = vi.fn()
const removeEventListener = vi.fn()

vi.mock('@/services/userDataService', () => ({
  userDataService: {
    addEventListener,
    removeEventListener,
    getUser: () => null,
    getCurrentUser: () => null,
    getUserProfile: () => null,
  },
}))

vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ settings: { allowCustomEmojisInDisplayNames: true } }),
}))

vi.mock('@/composables/useVisualTheme', () => ({
  useVisualTheme: () => ({ currentSettings: { value: {} } }),
}))

describe('useUserData service listeners', () => {
  beforeEach(() => {
    addEventListener.mockClear()
  })

  it('registers each service event exactly once no matter how many callers', async () => {
    const { useUserData } = await import('@/composables/useUserData')

    useUserData()
    const afterFirst = addEventListener.mock.calls.length

    for (let i = 0; i < 50; i++) useUserData()

    expect(addEventListener.mock.calls.length).toBe(afterFirst)

    const events = addEventListener.mock.calls.map(c => c[0])
    expect(new Set(events).size).toBe(events.length)
  })

  it('shares one reactivity signal across callers', async () => {
    const { useUserData } = await import('@/composables/useUserData')
    const a = useUserData()
    const b = useUserData()
    expect(a.isInitialized.value).toBe(true)
    expect(b.isInitialized.value).toBe(true)
  })
})
