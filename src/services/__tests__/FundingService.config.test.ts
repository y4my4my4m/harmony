/**
 * instance_funding is readable by signed-in users only; anon is refused with 42501 (401). The
 * funding config is not read without a session: at start before the session is attached, or
 * after sign-out while the refresh timer runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { auth, from, rpc, select } = vi.hoisted(() => {
  const query: any = {
    select: vi.fn(() => query),
    limit: () => query,
    maybeSingle: async () => ({ data: { id: 'f1', enabled: true }, error: null }),
  }
  return {
    auth: { getSession: vi.fn() },
    from: vi.fn(() => query),
    rpc: vi.fn(async () => ({ data: { id: 'm', body: 'hi', anonymous: false }, error: null })),
    select: query.select,
  }
})

vi.mock('@/supabase', () => ({ supabase: { auth, from, rpc } }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => true }))

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

describe('the instance\'s own funding', () => {
  it('reads the message switches with the funding columns, and no project column', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { access_token: 'jwt' } } })
    await fundingService.getFundingConfig()
    expect(select).toHaveBeenLastCalledWith(expect.stringContaining('supporter_messages_public'))
    expect(select).toHaveBeenLastCalledWith(expect.not.stringContaining('project'))
  })

  it('writes a supporter message with the two arguments set_supporter_message takes', async () => {
    await fundingService.setSupporterMessage('hi', true)
    expect(rpc).toHaveBeenLastCalledWith('set_supporter_message', { p_body: 'hi', p_anonymous: true })
  })

  it('counts every donation in the stats, with no fund column', async () => {
    await fundingService.getDonationStats()
    expect(from).toHaveBeenLastCalledWith('instance_donation_history')
    expect(select).toHaveBeenLastCalledWith('amount, user_id')
  })
})
