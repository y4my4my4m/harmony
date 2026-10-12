import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// A desktop activity status is a lease the app renews while the activity lasts, so it
// lapses on its own when the app quits or crashes.

const service = vi.hoisted(() => ({
  status: undefined as any,
  setCustomStatus: vi.fn(async (status: any) => { service.status = status }),
  clearCustomStatus: vi.fn(async () => { service.status = undefined }),
  getCustomStatus: vi.fn(() => service.status),
}))
vi.mock('@/services/userDataService', () => ({ userDataService: service }))
vi.mock('@/services/instanceConfig', () => ({ isTauriRuntime: () => true }))
vi.mock('@/utils/debug', () => ({ debug: { warn: vi.fn(), log: vi.fn() } }))

const { apply, LEASE_MINUTES, RENEW_MS } = await import('../nativePresence')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T00:00:00.000Z'))
  service.status = undefined
  service.setCustomStatus.mockClear()
  service.clearCustomStatus.mockClear()
})

afterEach(async () => {
  await apply(null)
  vi.useRealTimers()
})

describe('desktop activity status', () => {
  it('is written with an expiry and renewed while the activity lasts', async () => {
    await apply({ name: 'OBS Studio', kind: 'streaming' })
    expect(service.setCustomStatus).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'OBS Studio', type: 'streaming', expiresAt: '2026-10-12T00:03:00.000Z' }),
      LEASE_MINUTES,
    )

    await vi.advanceTimersByTimeAsync(RENEW_MS)
    expect(service.setCustomStatus).toHaveBeenCalledTimes(2)
    expect(service.status.expiresAt).toBe('2026-10-12T00:04:00.000Z')
  })

  it('is cleared when the activity ends, and renewed no more', async () => {
    await apply({ name: 'OBS Studio', kind: 'streaming' })
    await apply(null)
    expect(service.clearCustomStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RENEW_MS * 3)
    expect(service.setCustomStatus).toHaveBeenCalledTimes(1)
  })

  it('stops renewing once the user sets a status by hand', async () => {
    await apply({ name: 'Elden Ring', kind: 'playing' })
    service.status = { text: 'out for lunch' }
    await vi.advanceTimersByTimeAsync(RENEW_MS * 2)
    expect(service.setCustomStatus).toHaveBeenCalledTimes(1)
    expect(service.status.text).toBe('out for lunch')
  })
})
