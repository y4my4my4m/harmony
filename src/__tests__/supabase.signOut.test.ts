/**
 * Sign-out scopes. The API host passes GoTrue's /logout with scope=local only; signing
 * out other devices goes through sign_out_my_sessions, which requires aal2 once a factor
 * is verified.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.unmock('@/supabase')

const { client } = vi.hoisted(() => ({
  client: {
    auth: { signOut: vi.fn(), storageKey: 'sb-test-auth-token' },
    rpc: vi.fn(),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => client,
}))

vi.mock('@/services/instanceConfig', () => ({
  getStoredInstance: () => null,
  isTauriRuntime: () => false,
}))

const { signOutAndForget, signOutEverywhere } = await import('@/supabase')

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  client.auth.signOut.mockResolvedValue({ error: null })
  client.rpc.mockResolvedValue({ data: 1, error: null })
})

describe('signOutAndForget', () => {
  it('signs out this device only', async () => {
    await signOutAndForget()
    expect(client.auth.signOut).toHaveBeenCalledTimes(1)
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('drops the stored session when GoTrue no longer knows it', async () => {
    localStorage.setItem('sb-test-auth-token', '{"access_token":"x"}')
    client.auth.signOut.mockResolvedValue({ error: { name: 'AuthSessionMissingError' } })
    await signOutAndForget()
    expect(localStorage.getItem('sb-test-auth-token')).toBeNull()
  })
})

describe('signOutEverywhere', () => {
  it('removes the other sessions in the database, then signs this device out locally', async () => {
    await signOutEverywhere()
    expect(client.rpc).toHaveBeenCalledWith('sign_out_my_sessions', { p_scope: 'others' })
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(client.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      client.auth.signOut.mock.invocationCallOrder[0])
    for (const [args] of client.auth.signOut.mock.calls) expect(args).toEqual({ scope: 'local' })
  })

  it('still signs this device out when the database refuses', async () => {
    client.rpc.mockRejectedValue(new Error('network'))
    await signOutEverywhere()
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})
