import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'
import {
  fetchServerBots,
  groupServerBots,
  toServerBot,
  type ServerBotRow,
} from '@/services/serverBotsService'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const fresh = new Date(NOW - 5_000).toISOString()

function row(over: Partial<ServerBotRow> = {}): ServerBotRow {
  return {
    id: 'bot-1',
    username: 'helper',
    display_name: 'Helper',
    avatar_url: 'https://cdn.test/helper.png',
    bot_type: 'bot',
    status: 'online',
    custom_status: null,
    activity_type: null,
    activity_name: null,
    last_heartbeat_at: fresh,
    ...over,
  }
}

describe('toServerBot', () => {
  it('falls back to the username and the default avatar', () => {
    const bot = toServerBot(row({ display_name: '  ', avatar_url: null }), NOW)
    expect(bot.displayName).toBe('helper')
    expect(bot.avatarUrl).toBe('/default_avatar.webp')
    expect(bot.sortKey).toBe('helper')
  })

  it('maps presence to member-list status, stale heartbeats offline', () => {
    expect(toServerBot(row({ status: 'idle' }), NOW).status).toBe('away')
    expect(toServerBot(row({ status: 'dnd' }), NOW).status).toBe('busy')
    expect(toServerBot(row({ status: 'offline' }), NOW).status).toBe('offline')
    expect(toServerBot(row({ last_heartbeat_at: '2026-10-02T11:00:00Z' }), NOW).status).toBe('offline')
    expect(toServerBot(row({ status: 'offline', last_heartbeat_at: null }), NOW).status).toBe('offline')
  })

  it('renders the activity with its verb and keeps the type for the icon', () => {
    const bot = toServerBot(row({ activity_type: 'listening', activity_name: 'lo-fi' }), NOW)
    expect(bot.statusText).toBe('Listening to: lo-fi')
    expect(bot.activityType).toBe('listening')
  })

  it('prefers the custom status over the activity', () => {
    const bot = toServerBot(row({ custom_status: 'Type /help', activity_type: 'playing', activity_name: 'chess' }), NOW)
    expect(bot.statusText).toBe('Type /help')
    expect(bot.activityType).toBeNull()
  })

  it('shows an activity of unknown type as its name alone', () => {
    const bot = toServerBot(row({ activity_type: 'custom', activity_name: 'Serving 4 servers' }), NOW)
    expect(bot.statusText).toBe('Serving 4 servers')
    expect(bot.activityType).toBeNull()
    expect(toServerBot(row(), NOW).statusText).toBe('')
  })
})

describe('fetchServerBots', () => {
  beforeEach(() => {
    vi.mocked(supabase.rpc).mockReset()
  })

  it('calls get_server_bots for the server and maps the rows', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [row()], error: null } as any)
    const bots = await fetchServerBots('srv-1')
    expect(supabase.rpc).toHaveBeenCalledWith('get_server_bots', { p_server_id: 'srv-1' })
    expect(bots.map(b => b.id)).toEqual(['bot-1'])
  })

  it('throws the RPC error', async () => {
    const error = { code: '42501', message: 'permission denied' }
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error } as any)
    await expect(fetchServerBots('srv-1')).rejects.toBe(error)
  })
})

describe('groupServerBots', () => {
  const collator = new Intl.Collator()
  const bots = [
    toServerBot(row({ id: 'z', username: 'zeta', display_name: 'Zeta' }), NOW),
    toServerBot(row({ id: 'a', username: 'alpha', display_name: 'alpha' }), NOW),
    toServerBot(row({ id: 'm', username: 'mod-bot', display_name: 'Moderator', status: 'dnd' }), NOW),
    toServerBot(row({ id: 'o', username: 'old', display_name: 'Old', status: 'offline' }), NOW),
  ]

  it('groups by status and orders each group by display name', () => {
    const groups = groupServerBots(bots, '', collator)
    expect(groups.online.map(b => b.id)).toEqual(['a', 'z'])
    expect(groups.busy.map(b => b.id)).toEqual(['m'])
    expect(groups.away).toEqual([])
    expect(groups.offline.map(b => b.id)).toEqual(['o'])
  })

  it('filters by display name or username, case-insensitively', () => {
    expect(groupServerBots(bots, ' MOD ', collator).busy.map(b => b.id)).toEqual(['m'])
    expect(groupServerBots(bots, 'mod-b', collator).busy.map(b => b.id)).toEqual(['m'])
    const none = groupServerBots(bots, 'nothing', collator)
    expect([...none.online, ...none.away, ...none.busy, ...none.offline]).toEqual([])
  })
})
