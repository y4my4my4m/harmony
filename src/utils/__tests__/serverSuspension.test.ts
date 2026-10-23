import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string, named: Record<string, string>) => `${key}:${named.instance}` } } }))
vi.mock('@/stores/useInstanceSettings', () => ({ useInstanceSettingsStore: () => ({ settings: { domain: 'here.test' } }) }))

const { serverSuspension } = await import('../serverSuspension')
const { suspendedServerNotice } = await import('../serverSuspensionNotice')

describe('serverSuspension', () => {
  it('is null for a server that is not suspended', () => {
    expect(serverSuspension({ suspended_at: null }, 'here.test')).toBeNull()
    expect(serverSuspension(null, 'here.test')).toBeNull()
  })

  it('names this instance for a server hosted here, with the reason', () => {
    expect(serverSuspension({ suspended_at: '2026-10-23T00:00:00Z', suspended_reason: ' raids ', is_local_server: true }, 'here.test'))
      .toEqual({ instance: 'here.test', reason: 'raids' })
  })

  it('names the host of a copy', () => {
    expect(serverSuspension({
      suspended_at: '2026-10-23T00:00:00Z', suspended_reason: '', is_local_server: false, federation_domain: 'host.test',
    }, 'here.test')).toEqual({ instance: 'host.test', reason: null })
  })

  it('words a refused join as the banner', () => {
    expect(suspendedServerNotice()).toBe('hostStaff.suspendedBanner:here.test')
  })
})
