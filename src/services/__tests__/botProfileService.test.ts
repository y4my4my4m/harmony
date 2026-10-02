import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'
import {
  addBotToServer,
  botWebsite,
  fetchBotProfile,
  removeBotFromServer,
  toBotProfile,
  type BotProfileRow,
} from '@/services/botProfileService'

vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentProfileId: vi.fn().mockResolvedValue('profile-1') },
}))

const NOW = Date.parse('2026-10-02T12:00:00Z')

function row(over: Partial<BotProfileRow> = {}): BotProfileRow {
  return {
    id: 'bot-1',
    username: 'helper',
    display_name: 'Helper',
    avatar_url: null,
    banner_url: null,
    bio: '  Answers questions.  ',
    bot_type: 'bot',
    is_verified: true,
    is_public: true,
    website_url: 'https://helper.test/docs',
    created_at: '2026-01-01T00:00:00Z',
    support_server: null,
    presence: {
      status: 'online',
      custom_status: null,
      activity_type: 'watching',
      activity_name: 'the logs',
      last_heartbeat_at: new Date(NOW - 1_000).toISOString(),
    },
    commands: [{ name: 'help', description: 'List commands' }],
    ...over,
  }
}

describe('botWebsite', () => {
  it('links http and https URLs, labelled by host and path', () => {
    expect(botWebsite('https://helper.test/docs')).toEqual({ href: 'https://helper.test/docs', label: 'helper.test/docs' })
    expect(botWebsite('http://helper.test/')).toEqual({ href: 'http://helper.test/', label: 'helper.test' })
  })

  it('drops other schemes and unparseable values', () => {
    expect(botWebsite('javascript:alert(1)')).toBeNull()
    expect(botWebsite(' JavaScript:alert(1)')).toBeNull()
    expect(botWebsite('data:text/html,hi')).toBeNull()
    expect(botWebsite('ftp://helper.test')).toBeNull()
    expect(botWebsite('helper.test')).toBeNull()
    expect(botWebsite('')).toBeNull()
    expect(botWebsite(null)).toBeNull()
  })
})

describe('toBotProfile', () => {
  it('derives presence and status text as the member list does', () => {
    const p = toBotProfile(row(), NOW)
    expect(p.status).toBe('online')
    expect(p.statusText).toBe('Watching: the logs')
    expect(p.bio).toBe('Answers questions.')
    expect(p.isVerified).toBe(true)
    expect(p.website?.href).toBe('https://helper.test/docs')
  })

  it('reads a missing presence row as offline and missing commands as none', () => {
    const p = toBotProfile(row({ presence: null, commands: null, website_url: 'javascript:x' }), NOW)
    expect(p.status).toBe('offline')
    expect(p.statusText).toBe('')
    expect(p.commands).toEqual([])
    expect(p.website).toBeNull()
  })
})

describe('fetchBotProfile', () => {
  beforeEach(() => {
    vi.mocked(supabase.rpc).mockReset()
  })

  it('calls get_bot_profile and maps the row', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: row(), error: null } as any)
    const p = await fetchBotProfile('bot-1')
    expect(supabase.rpc).toHaveBeenCalledWith('get_bot_profile', { p_bot_id: 'bot-1' })
    expect(p?.username).toBe('helper')
  })

  it('returns null for a bot the caller may not see', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as any)
    expect(await fetchBotProfile('bot-1')).toBeNull()
  })

  it('throws the RPC error', async () => {
    const error = { code: '42501', message: 'permission denied' }
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error } as any)
    await expect(fetchBotProfile('bot-1')).rejects.toBe(error)
  })
})

describe('installation writes', () => {
  beforeEach(() => {
    vi.mocked(supabase.rpc).mockReset()
    vi.mocked(supabase.from).mockReset()
  })

  it('installs through add_bot_to_server with the default permissions for the bot type', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: 'inst-1', error: null } as any)
    await addBotToServer('bot-1', 'bridge', 'srv-1')
    expect(supabase.rpc).toHaveBeenCalledWith('add_bot_to_server', {
      p_bot_id: 'bot-1',
      p_server_id: 'srv-1',
      p_installed_by: 'profile-1',
      p_permissions: {
        read_messages: true,
        send_messages: true,
        add_reactions: true,
        manage_messages: false,
        manage_channels: true,
      },
    })
  })

  function updateChain(result: { data: unknown; error: unknown }) {
    const calls: unknown[][] = []
    const q: any = {
      update: (...a: unknown[]) => { calls.push(['update', ...a]); return q },
      eq: (...a: unknown[]) => { calls.push(['eq', ...a]); return q },
      select: (...a: unknown[]) => { calls.push(['select', ...a]); return Promise.resolve(result) },
    }
    vi.mocked(supabase.from).mockReturnValue(q)
    return calls
  }

  it('removes by deactivating the installation of the bot in the server', async () => {
    const calls = updateChain({ data: [{ id: 'inst-1' }], error: null })
    await removeBotFromServer('bot-1', 'srv-1')
    expect(supabase.from).toHaveBeenCalledWith('bot_server_permissions')
    expect(calls).toEqual([
      ['update', { is_active: false }],
      ['eq', 'bot_id', 'bot-1'],
      ['eq', 'server_id', 'srv-1'],
      ['select', 'id'],
    ])
  })

  it('fails when RLS filters the update to no rows', async () => {
    updateChain({ data: [], error: null })
    await expect(removeBotFromServer('bot-1', 'srv-1')).rejects.toThrow('not updated')
  })
})
