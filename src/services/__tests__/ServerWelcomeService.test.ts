import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import {
  cleanWelcomeError,
  getOnboardingServers,
  getServerWelcome,
  setServerWelcome,
  setWelcomeServer,
} from '@/services/ServerWelcomeService'

const rpc = vi.mocked(supabase.rpc)

beforeEach(() => {
  rpc.mockReset()
})

describe('ServerWelcomeService', () => {
  it('sends trimmed, titled rules to set_server_welcome', async () => {
    rpc.mockResolvedValue({ data: { server_id: 's1', rules: [], message: '' }, error: null } as never)
    await setServerWelcome('s1', {
      enabled: true,
      message: 'Hi',
      rules: [
        { title: '  Be kind ', description: ' No attacks ' },
        { title: '   ', description: '' },
      ],
      requireAcceptance: true,
    })
    expect(rpc).toHaveBeenCalledWith('set_server_welcome', {
      p_server_id: 's1',
      p_enabled: true,
      p_message: 'Hi',
      p_rules: [{ title: 'Be kind', description: 'No attacks' }],
      p_require_acceptance: true,
    })
  })

  it('normalizes the screen it reads', async () => {
    rpc.mockResolvedValue({
      data: { server_id: 's1', message: null, rules: [{ title: 'A' }, { description: 'orphan' }, 'junk'] },
      error: null,
    } as never)
    const w = await getServerWelcome('s1')
    expect(w.message).toBe('')
    expect(w.rules).toEqual([{ title: 'A', description: '' }])
  })

  it('reads onboarding suggestions with numeric member counts', async () => {
    rpc.mockResolvedValue({
      data: { source: 'welcome', servers: [{ id: 'h', name: 'Town Hall', member_count: '83' }] },
      error: null,
    } as never)
    const s = await getOnboardingServers()
    expect(s.source).toBe('welcome')
    expect(s.servers[0].member_count).toBe(83)

    rpc.mockResolvedValue({ data: null, error: null } as never)
    expect(await getOnboardingServers()).toEqual({ source: 'none', servers: [] })
  })

  it('clears the welcome server with null and surfaces validation errors without their prefix', async () => {
    rpc.mockResolvedValue({ data: { welcome_server_id: null }, error: null } as never)
    await setWelcomeServer(null)
    expect(rpc).toHaveBeenCalledWith('set_welcome_server', { p_server_id: null })

    rpc.mockResolvedValue({
      data: null,
      error: { message: 'WELCOME_SERVER_INVALID: the welcome server is a public server on this instance' },
    } as never)
    await expect(setWelcomeServer('x')).rejects.toThrow('the welcome server is a public server on this instance')
    expect(cleanWelcomeError('WELCOME_INVALID: at most 20 rules')).toBe('at most 20 rules')
  })
})
