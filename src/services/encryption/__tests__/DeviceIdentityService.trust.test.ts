import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'
import { deviceIdentityService } from '../DeviceIdentityService'

const USER = '11111111-0000-0000-0000-000000000001'

/** supabase.from() chain ending in maybeSingle() with `result`; records delete(). */
function rowQuery(result: { data: unknown; error: unknown }) {
  const calls: string[] = []
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    delete: () => { calls.push('delete'); return chain },
    maybeSingle: async () => result,
    then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
  }
  return { chain, calls }
}

describe('DeviceIdentityService device trust and removal', () => {
  let deviceId: string

  beforeEach(() => {
    localStorage.clear()
    vi.mocked(supabase.from).mockReset()
    vi.mocked(supabase.rpc).mockReset()
    deviceId = deviceIdentityService.getDeviceId()
  })

  it('reports a revoked row as revoked', async () => {
    vi.mocked(supabase.from).mockReturnValue(rowQuery({ data: { device_id: deviceId, revoked_at: '2026-10-01T00:00:00Z', trust_state: 'revoked' }, error: null }).chain)
    expect(await deviceIdentityService.getThisDeviceState(USER)).toBe('revoked')
  })

  it('reports an active row as active', async () => {
    vi.mocked(supabase.from).mockReturnValue(rowQuery({ data: { device_id: deviceId, revoked_at: null, trust_state: 'account' }, error: null }).chain)
    expect(await deviceIdentityService.getThisDeviceState(USER)).toBe('active')
  })

  it('reports a missing row as removed only once this install has seen it', async () => {
    vi.mocked(supabase.from).mockReturnValue(rowQuery({ data: null, error: null }).chain)
    expect(await deviceIdentityService.getThisDeviceState(USER)).toBe('unregistered')
    localStorage.setItem('harmony_device_registered', deviceId)
    expect(await deviceIdentityService.getThisDeviceState(USER)).toBe('removed')
  })

  it('reports a failed lookup as unknown, never as removed', async () => {
    localStorage.setItem('harmony_device_registered', deviceId)
    vi.mocked(supabase.from).mockReturnValue(rowQuery({ data: null, error: { message: 'offline' } }).chain)
    expect(await deviceIdentityService.getThisDeviceState(USER)).toBe('unknown')
    vi.mocked(supabase.from).mockImplementation(() => { throw new Error('network') })
    expect(await deviceIdentityService.getThisDeviceState(USER)).toBe('unknown')
  })

  it('forgetThisDevice starts a new device identity', () => {
    localStorage.setItem('harmony_device_registered', deviceId)
    deviceIdentityService.forgetThisDevice()
    expect(deviceIdentityService.getDeviceId()).not.toBe(deviceId)
    expect(localStorage.getItem('harmony_device_registered')).toBeNull()
  })

  it('signs devices out and claims recovery trust through the RPCs', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as any)
    await deviceIdentityService.revokeDevice('other-device')
    expect(supabase.rpc).toHaveBeenCalledWith('revoke_device', { p_device_id: 'other-device' })
    expect(await deviceIdentityService.claimRecoveryTrust(deviceId)).toBe(true)
    expect(supabase.rpc).toHaveBeenCalledWith('claim_device_recovery_trust', { p_device_id: deviceId })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('signs a device out before removing its row', async () => {
    const order: string[] = []
    vi.mocked(supabase.rpc).mockImplementation(async (name: string) => {
      order.push(name)
      return { data: true, error: null } as any
    })
    const q = rowQuery({ data: null, error: null })
    vi.mocked(supabase.from).mockImplementation(() => { order.push('from'); return q.chain })
    vi.spyOn(deviceIdentityService as any, 'resolveUserId').mockResolvedValue(USER)
    await deviceIdentityService.deleteDevice('other-device')
    expect(order).toEqual(['revoke_device', 'from'])
    expect(q.calls).toEqual(['delete'])
  })
})
