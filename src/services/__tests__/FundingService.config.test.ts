/**
 * instance_funding is readable by signed-in users only; anon is refused with 42501 (401). The
 * funding config is not read without a session: at start before the session is attached, or
 * after sign-out while the refresh timer runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { auth, from } = vi.hoisted(() => {
  const query: any = {
    select: () => query,
    limit: () => query,
    maybeSingle: async () => ({ data: { id: 'f1', enabled: true }, error: null }),
  }
  return {
    auth: { getSession: vi.fn() },
    from: vi.fn(() => query),
  }
})

vi.mock('@/supabase', () => ({ supabase: { auth, from, rpc: vi.fn() } }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { fundingService } from '../FundingService'

beforeEach(() => {
  from.mockClear()
  auth.getSession.mockReset()
})

describe('fundingService.getFundingConfig', () => {
  it('reads nothing without a session', async () => {
    auth.getSession.mockResolvedValue({ data: { session: null } })
    expect(await fundingService.getFundingConfig()).toBeNull()
    expect(from).not.toHaveBeenCalled()
  })

  it('reads instance_funding with one', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } })
    expect(await fundingService.getFundingConfig()).toEqual({ id: 'f1', enabled: true })
    expect(from).toHaveBeenCalledWith('instance_funding')
  })
})
