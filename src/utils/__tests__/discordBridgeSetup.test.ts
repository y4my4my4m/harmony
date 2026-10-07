/**
 * discordBridgeSetup: invite URL, status/snapshot parsing, checklist, problems, step
 * derivation, commands, token checks and channel pairing helpers.
 */
import { describe, it, expect } from 'vitest'
import {
  DISCORD_BRIDGE_PERMISSIONS_VALUE,
  DISCORD_TOKEN_PLACEHOLDER,
  buildChecklist,
  buildDiscordInviteUrl,
  buildDockerCompose,
  buildDockerRunCommand,
  checkDiscordToken,
  collectProblems,
  deriveSetupStep,
  discordChannelIssues,
  groupDiscordTextChannels,
  isBridgeOnline,
  matchChannelsByName,
  normalizeBridgeSettings,
  normalizeChannelName,
  parseBridgeStatus,
  parseSnapshotGuilds,
  requiredIntents,
  type DiscordBridgeRow,
  type SnapshotChannel,
} from '../discordBridgeSetup'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const SEEN = '2026-10-07T11:59:50Z'
const STALE = '2026-10-07T11:50:00Z'

const healthyStatus = {
  version: '2.0.0',
  discord: {
    connected: true,
    application_id: '111111111111111111',
    bot_user: { id: '222', name: 'Town Bridge', avatar: null },
    intents: { message_content: true, members: true, presence: false },
  },
  harmony: { connected: true },
  problems: [],
}

const snapshot = {
  guilds: [
    {
      id: '900',
      name: 'Town Square',
      icon: null,
      channels: [
        { id: '10', name: 'Text', type: 4, parent_id: null, position: 0, can_view: true, can_send: true, can_manage_webhooks: true },
        { id: '11', name: 'general', type: 0, parent_id: '10', position: 1, can_view: true, can_send: true, can_manage_webhooks: true },
        { id: '12', name: 'secret', type: 0, parent_id: '10', position: 2, can_view: false, can_send: false, can_manage_webhooks: false },
        { id: '13', name: 'news', type: 5, parent_id: null, position: 0, can_view: true, can_send: false, can_manage_webhooks: false },
        { id: '14', name: 'Voice', type: 2, parent_id: null, position: 3, can_view: true, can_send: true, can_manage_webhooks: true },
      ],
    },
  ],
}

function bridge(overrides: Partial<DiscordBridgeRow> = {}): DiscordBridgeRow {
  return {
    id: 'b1',
    server_id: 's1',
    bot_id: 'bot1',
    mode: 'self',
    discord_guild_id: null,
    discord_guild_name: null,
    discord_application_id: null,
    discord_bot_name: null,
    settings: { sync_member_list: true, sync_presence: false, sync_reactions: true, sync_edits: true, sync_deletes: true },
    snapshot: null,
    status: null,
    bridge_version: null,
    last_seen_at: null,
    ...overrides,
  }
}

describe('buildDiscordInviteUrl', () => {
  it('asks for bot + applications.commands and exactly the seven bridge permissions', () => {
    expect(DISCORD_BRIDGE_PERMISSIONS_VALUE).toBe('536988736')
    const url = new URL(buildDiscordInviteUrl('111111111111111111'))
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('111111111111111111')
    expect(url.searchParams.get('scope')).toBe('bot applications.commands')
    expect(url.searchParams.get('permissions')).toBe('536988736')
  })

  it('returns nothing for a missing or malformed application id', () => {
    expect(buildDiscordInviteUrl(null)).toBe('')
    expect(buildDiscordInviteUrl('not-an-id')).toBe('')
  })
})

describe('parsing', () => {
  it('reads the heartbeat status shape', () => {
    const status = parseBridgeStatus({ ...healthyStatus, problems: [{ code: 'cannot_send', params: { discord_channel_id: 11 } }, { bogus: 1 }] })
    expect(status.discordConnected).toBe(true)
    expect(status.applicationId).toBe('111111111111111111')
    expect(status.botName).toBe('Town Bridge')
    expect(status.intents).toEqual({ message_content: true, members: true, presence: false })
    expect(status.harmonyConnected).toBe(true)
    expect(status.problems).toEqual([{ code: 'cannot_send', params: { discord_channel_id: '11' } }])
  })

  it('tolerates an empty status', () => {
    const status = parseBridgeStatus(null)
    expect(status.discordConnected).toBeNull()
    expect(status.problems).toEqual([])
  })

  it('accepts the snapshot as {guilds} or as the bare array', () => {
    expect(parseSnapshotGuilds(snapshot)).toHaveLength(1)
    expect(parseSnapshotGuilds(snapshot.guilds)[0].channels[1]).toMatchObject({ id: '11', canView: true, parentId: '10' })
    expect(parseSnapshotGuilds(undefined)).toEqual([])
  })

  it('fills missing settings with the column default', () => {
    expect(normalizeBridgeSettings({ sync_presence: true, junk: 1 })).toEqual({
      sync_member_list: true,
      sync_presence: true,
      sync_reactions: true,
      sync_edits: true,
      sync_deletes: true,
    })
  })

  it('groups text and announcement channels under their categories', () => {
    const groups = groupDiscordTextChannels(parseSnapshotGuilds(snapshot)[0])
    expect(groups.map((g) => [g.categoryName, g.channels.map((c) => c.name)])).toEqual([
      [null, ['news']],
      ['Text', ['general', 'secret']],
    ])
  })
})

describe('liveness and intents', () => {
  it('counts a bridge online for three heartbeats', () => {
    expect(isBridgeOnline(SEEN, NOW)).toBe(true)
    expect(isBridgeOnline(STALE, NOW)).toBe(false)
    expect(isBridgeOnline(null, NOW)).toBe(false)
  })

  it('needs Message Content always and the others with their sync settings', () => {
    expect(requiredIntents(normalizeBridgeSettings({ sync_member_list: false, sync_presence: false }))).toEqual(['message_content'])
    expect(requiredIntents(normalizeBridgeSettings({ sync_member_list: true, sync_presence: true }))).toEqual([
      'message_content',
      'members',
      'presence',
    ])
  })
})

describe('buildChecklist', () => {
  const states = (b: DiscordBridgeRow) => Object.fromEntries(buildChecklist(b, NOW).map((i) => [i.key, i.state]))

  it('waits on everything before the first heartbeat', () => {
    expect(new Set(Object.values(states(bridge())))).toEqual(new Set(['waiting']))
  })

  it('fails the bridge item when the heartbeat is stale', () => {
    expect(states(bridge({ last_seen_at: STALE, status: healthyStatus, snapshot }))).toMatchObject({ bridge: 'fail', token: 'waiting' })
  })

  it('leaves intents unchecked while Discord rejects the token', () => {
    const rejected = {
      discord: { connected: false, application_id: null, bot_user: null, intents: { message_content: false, members: false, presence: false } },
      harmony: { connected: true },
      problems: [{ code: 'discord_token_invalid', params: {} }],
    }
    expect(states(bridge({ last_seen_at: SEEN, status: rejected }))).toMatchObject({ bridge: 'ok', token: 'fail', intents: 'waiting', harmony: 'ok' })
  })

  it('passes a healthy bridge', () => {
    expect(states(bridge({ last_seen_at: SEEN, status: healthyStatus, snapshot }))).toEqual({
      bridge: 'ok',
      token: 'ok',
      intents: 'ok',
      invited: 'ok',
      harmony: 'ok',
    })
  })

  it('fails each item from its problem code', () => {
    const status = {
      ...healthyStatus,
      discord: { ...healthyStatus.discord, connected: false },
      harmony: { connected: false },
      problems: [{ code: 'discord_token_invalid' }, { code: 'intent_missing', params: { intent: 'members' } }, { code: 'no_guild' }, { code: 'harmony_auth_failed' }],
    }
    expect(states(bridge({ last_seen_at: SEEN, status }))).toEqual({
      bridge: 'ok',
      token: 'fail',
      intents: 'fail',
      invited: 'fail',
      harmony: 'fail',
    })
  })

  it('fails intents when a needed intent is reported off without a problem entry', () => {
    const status = { ...healthyStatus, discord: { ...healthyStatus.discord, intents: { message_content: true, members: false, presence: false } } }
    expect(states(bridge({ last_seen_at: SEEN, status, snapshot })).intents).toBe('fail')
  })
})

describe('collectProblems', () => {
  it('leads with bridge_offline for a stale heartbeat', () => {
    const problems = collectProblems(bridge({ last_seen_at: STALE, status: { ...healthyStatus, problems: [{ code: 'rate_limited' }] }, snapshot }), NOW)
    expect(problems.map((p) => p.code)).toEqual(['bridge_offline', 'rate_limited'])
  })

  it('adds intent_missing and no_guild from the status and snapshot, without duplicates', () => {
    const status = {
      ...healthyStatus,
      discord: { ...healthyStatus.discord, intents: { message_content: true, members: false, presence: false } },
      problems: [{ code: 'intent_missing', params: { intent: 'members' } }],
    }
    const problems = collectProblems(bridge({ last_seen_at: SEEN, status, snapshot: { guilds: [] } }), NOW)
    expect(problems).toEqual([
      { code: 'intent_missing', params: { intent: 'members' } },
      { code: 'no_guild', params: {} },
    ])
  })

  it('is empty before the first heartbeat', () => {
    expect(collectProblems(bridge(), NOW)).toEqual([])
  })
})

describe('deriveSetupStep', () => {
  it('starts at the bot step and resumes where the admin got to', () => {
    expect(deriveSetupStep(bridge(), 0, NOW)).toBe('bot')
    expect(deriveSetupStep(bridge(), 0, NOW, 'connect')).toBe('connect')
    expect(deriveSetupStep(bridge(), 0, NOW, 'check')).toBe('check')
  })

  it('walks check → guild → channels → options from the row', () => {
    const healthy = bridge({ last_seen_at: SEEN, status: healthyStatus, snapshot })
    expect(deriveSetupStep(bridge({ last_seen_at: SEEN, status: { ...healthyStatus, problems: [{ code: 'no_guild' }] } }), 0, NOW)).toBe('check')
    expect(deriveSetupStep(healthy, 0, NOW)).toBe('guild')
    expect(deriveSetupStep({ ...healthy, discord_guild_id: '900' }, 0, NOW)).toBe('channels')
    expect(deriveSetupStep({ ...healthy, discord_guild_id: '900' }, 2, NOW)).toBe('options')
  })
})

describe('commands', () => {
  const input = { harmonyUrl: 'https://harmony.example', setupCode: 'HB-ABCD-EFGH-JKLM' }

  it('builds a single-line docker run command', () => {
    const command = buildDockerRunCommand(input)
    expect(command).not.toContain('\n')
    expect(command).toBe(
      'docker run -d --name harmony-discord-bridge --restart unless-stopped -e HARMONY_URL=https://harmony.example ' +
        `-e HARMONY_SETUP_CODE=HB-ABCD-EFGH-JKLM -e DISCORD_TOKEN=${DISCORD_TOKEN_PLACEHOLDER} ` +
        '-v harmony-bridge-data:/data ghcr.io/y4my4my4m/harmony-discord-bridge:latest',
    )
  })

  it('placeholder carries no shell metacharacters', () => {
    expect(DISCORD_TOKEN_PLACEHOLDER).toMatch(/^[A-Z_]+$/)
  })

  it('builds the compose variant with the same values', () => {
    const compose = buildDockerCompose(input)
    expect(compose).toContain('HARMONY_URL: "https://harmony.example"')
    expect(compose).toContain('HARMONY_SETUP_CODE: "HB-ABCD-EFGH-JKLM"')
    expect(compose).toContain(`DISCORD_TOKEN: "${DISCORD_TOKEN_PLACEHOLDER}"`)
    expect(compose).toContain('- harmony-bridge-data:/data')
    expect(compose).toContain('restart: unless-stopped')
  })
})

describe('checkDiscordToken', () => {
  const token = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.')

  it('accepts a bot token, stripping whitespace, quotes and a Bot prefix', () => {
    expect(checkDiscordToken(`  Bot "${token}" `)).toEqual({ token, issue: null })
  })

  it('names the other portal values', () => {
    expect(checkDiscordToken('').issue).toBe('empty')
    expect(checkDiscordToken('111111111111111111').issue).toBe('applicationId')
    expect(checkDiscordToken('a'.repeat(64)).issue).toBe('publicKey')
    expect(checkDiscordToken('AbCdEfGhIjKlMnOpQrStUvWxYz012345').issue).toBe('clientSecret')
    expect(checkDiscordToken(`harmony_bot_${'f'.repeat(64)}`).issue).toBe('harmonyToken')
    expect(checkDiscordToken('hello world').issue).toBe('notToken')
  })
})

describe('channel pairing helpers', () => {
  const channel = (overrides: Partial<SnapshotChannel>): SnapshotChannel => ({
    id: 'x',
    name: 'x',
    type: 0,
    parentId: null,
    position: 0,
    canView: true,
    canSend: true,
    canManageWebhooks: true,
    ...overrides,
  })

  it('reports what blocks or degrades a pair per direction', () => {
    expect(discordChannelIssues(channel({ canView: false }), 'both')).toEqual(['not_visible'])
    expect(discordChannelIssues(channel({ canSend: false, canManageWebhooks: false }), 'to_harmony')).toEqual([])
    expect(discordChannelIssues(channel({ canSend: false, canManageWebhooks: false }), 'to_discord')).toEqual([
      'cannot_send',
      'cannot_manage_webhooks',
    ])
  })

  it('normalizes emoji, case and separators', () => {
    expect(normalizeChannelName('💬 General Chat')).toBe('general-chat')
    expect(normalizeChannelName('general-chat')).toBe('general-chat')
    expect(normalizeChannelName('Café')).toBe('cafe')
  })

  it('matches unique unpaired names whose Discord side is visible', () => {
    const harmony = [
      { id: 'h1', name: 'general', categoryName: null },
      { id: 'h2', name: 'secret', categoryName: null },
      { id: 'h3', name: 'memes', categoryName: null },
      { id: 'h4', name: 'paired', categoryName: null },
    ]
    const discord = [
      channel({ id: 'd1', name: '💬general' }),
      channel({ id: 'd2', name: 'secret', canView: false }),
      channel({ id: 'd4', name: 'paired' }),
      channel({ id: 'd5', name: 'memes', type: 2 }),
    ]
    const matches = matchChannelsByName(harmony, discord, [{ harmony_channel_id: 'h4', discord_channel_id: 'd4' }])
    expect(matches.map((m) => [m.harmony.id, m.discord.id])).toEqual([['h1', 'd1']])
  })
})
