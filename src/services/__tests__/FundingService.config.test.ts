/**
 * instance_funding is readable by signed-in users only; anon is refused with 42501 (401). The
 * funding config is not read without a session: at start before the session is attached, or
 * after sign-out while the refresh timer runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { auth, from, rpc, upsert } = vi.hoisted(() => {
  const upsert = vi.fn(async () => ({ error: null }))
  const query: any = {
    select: () => query,
    limit: () => query,
    maybeSingle: async () => ({ data: { id: 'f1', enabled: true }, error: null }),
    upsert,
  }
  return {
    auth: { getSession: vi.fn() },
    from: vi.fn(() => query),
    rpc: vi.fn(async () => ({ data: { id: 'm', body: 'hi', anonymous: false }, error: null })),
    upsert,
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

describe('fundingService.getProjectFunding', () => {
  it('uses the browser cache unless asked for a fresh read', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ projectInstance: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect(await fundingService.getProjectFunding()).toEqual({ projectInstance: true })
      expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ cache: 'default' })
      await fundingService.getProjectFunding({ fresh: true })
      expect((fetchMock.mock.calls[1] as unknown[])[1]).toMatchObject({ cache: 'no-cache' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the project fund', () => {
  it('writes a message to the instance\'s fund with two arguments, to the project\'s with p_fund', async () => {
    await fundingService.setSupporterMessage('hi', false)
    expect(rpc).toHaveBeenLastCalledWith('set_supporter_message', { p_body: 'hi', p_anonymous: false })
    await fundingService.setSupporterMessage('hi', true, 'project')
    expect(rpc).toHaveBeenLastCalledWith('set_supporter_message', { p_body: 'hi', p_anonymous: true, p_fund: 'project' })
  })

  it('writes project_funding\'s one row', async () => {
    const settings = {
      enabled: true, goal_amount: 500, goal_currency: 'USD', funding_period: 'monthly' as const, goal_description: null,
      funding_links: [], supporter_messages_enabled: true, supporter_messages_public: true,
      stripe_payment_links: ['plink_1UYKJgIByukKkdhljBcFnf5I'],
    }
    expect(await fundingService.saveProjectFundingSettings(settings)).toEqual({ ok: true })
    expect(from).toHaveBeenLastCalledWith('project_funding')
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: true, ...settings }), { onConflict: 'id' })
  })
})
