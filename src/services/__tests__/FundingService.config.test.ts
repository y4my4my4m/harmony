/**
 * instance_funding is readable by signed-in users only; anon is refused with 42501 (401). The
 * funding config is not read without a session: at start before the session is attached, or
 * after sign-out while the refresh timer runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { auth, from, rpc, upsert, select } = vi.hoisted(() => {
  const upsert = vi.fn(async () => ({ error: null }))
  const query: any = {
    select: vi.fn(() => query),
    limit: () => query,
    maybeSingle: async () => ({ data: { id: 'f1', enabled: true }, error: null }),
    upsert,
  }
  return {
    auth: { getSession: vi.fn() },
    from: vi.fn(() => query),
    rpc: vi.fn(async () => ({ data: { id: 'm', body: 'hi', anonymous: false }, error: null })),
    upsert,
    select: query.select,
  }
})

vi.mock('@/supabase', () => ({ supabase: { auth, from, rpc } }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => true }))

import { fundingService, PROJECT_DOMAIN, PROJECT_LINKS } from '../FundingService'

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

  it('writes project_funding\'s one row, which holds no links', async () => {
    const settings = {
      enabled: true, goal_amount: 500, goal_currency: 'USD', funding_period: 'monthly' as const, goal_description: null,
      supporter_messages_enabled: true, supporter_messages_public: true,
    }
    expect(await fundingService.saveProjectFundingSettings(settings)).toEqual({ ok: true })
    expect(from).toHaveBeenLastCalledWith('project_funding')
    expect(upsert).toHaveBeenCalledWith({ id: true, ...settings, updated_at: expect.any(String) }, { onConflict: 'id' })
    await fundingService.getProjectFundingSettings()
    expect(select).toHaveBeenLastCalledWith(expect.not.stringMatching(/link/))
  })

  it('links to the Harmony project\'s own payment pages', () => {
    expect(PROJECT_DOMAIN).toBe('har.mony.lol')
    expect(PROJECT_LINKS).toEqual([
      { platform: 'stripe', url: 'https://donate.stripe.com/fZu8wQ29W5S97hrcqKb7y03', label: 'One-time' },
      { platform: 'stripe', url: 'https://donate.stripe.com/8x25kEbKwbct59jcqKb7y04', label: 'Monthly' },
      { platform: 'ko-fi', url: 'https://ko-fi.com/y4my4my4m', label: 'Ko-fi' },
    ])
    expect(Object.isFrozen(PROJECT_LINKS) && PROJECT_LINKS.every((l) => Object.isFrozen(l))).toBe(true)
  })
})
