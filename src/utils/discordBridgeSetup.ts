/**
 * Discord bridge v2: row shapes, status/snapshot parsing, setup-step derivation and
 * the copy-paste commands shown in Server Settings → Discord Bridge.
 */
import { getInstanceDomain, getStoredInstance } from '@/services/instanceConfig'
import { runtimeConfig } from '@/services/runtimeConfig'

// ---------------------------------------------------------------------------
// Discord invite
// ---------------------------------------------------------------------------

/** Discord permission bits (https://discord.com/developers/docs/topics/permissions). */
export const DISCORD_BRIDGE_PERMISSION_FLAGS = {
  addReactions: 1n << 6n,
  viewChannel: 1n << 10n,
  sendMessages: 1n << 11n,
  embedLinks: 1n << 14n,
  attachFiles: 1n << 15n,
  readMessageHistory: 1n << 16n,
  manageWebhooks: 1n << 29n,
} as const

/** View Channels, Send Messages, Read Message History, Add Reactions, Embed Links, Attach Files, Manage Webhooks = 536988736. */
export const DISCORD_BRIDGE_PERMISSIONS_VALUE = Object.values(DISCORD_BRIDGE_PERMISSION_FLAGS)
  .reduce((acc, flag) => acc | flag, 0n)
  .toString()

export const DISCORD_BRIDGE_SCOPES = 'bot applications.commands'

export const DISCORD_DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications'

export function buildDiscordInviteUrl(applicationId: string | null | undefined): string {
  const id = applicationId?.trim() ?? ''
  if (!/^\d{5,25}$/.test(id)) return ''
  const params = new URLSearchParams({
    client_id: id,
    permissions: DISCORD_BRIDGE_PERMISSIONS_VALUE,
    scope: DISCORD_BRIDGE_SCOPES,
  })
  return `https://discord.com/oauth2/authorize?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Instance bot (bridge v2.1): OAuth2 through bot-gateway's /bridge/v2/discord routes
// ---------------------------------------------------------------------------

/** Path of the OAuth2 redirect URI registered on the instance's Discord application. */
export const INSTANCE_BOT_CALLBACK_PATH = '/bot-gateway/bridge/v2/discord/callback'

/** Redirect URI the operator registers in the Discord Developer Portal: the gateway builds the same from INSTANCE_DOMAIN. */
export function buildInstanceBotRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}${INSTANCE_BOT_CALLBACK_PATH}`
}

/** Gateway route that redirects to Discord's consent screen for a state from discord_bridge_instance_link. */
export function buildInstanceAuthorizeUrl(baseUrl: string, state: string): string {
  return `${baseUrl.replace(/\/$/, '')}/bot-gateway/bridge/v2/discord/authorize?state=${encodeURIComponent(state)}`
}

/** link_error values of GET /bridge/v2/discord/callback's return to Server Settings. */
export const LINK_ERROR_CODES = [
  'state_invalid',
  'guild_linked_elsewhere',
  'discord_denied',
  'exchange_failed',
  'limit_reached',
] as const
export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number]

export interface BridgeLinkReturn {
  linked: boolean
  error: LinkErrorCode | null
}

/**
 * ?linked=1 or ?link_error=<code> on Server Settings, as the callback redirects; null when
 * neither is present. An unknown code reads as exchange_failed.
 */
export function parseBridgeLinkReturn(query: Record<string, unknown>): BridgeLinkReturn | null {
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value)
  const linked = first(query.linked)
  const error = first(query.link_error)
  if (typeof error === 'string' && error) {
    const code = (LINK_ERROR_CODES as readonly string[]).includes(error) ? (error as LinkErrorCode) : 'exchange_failed'
    return { linked: false, error: code }
  }
  if (linked === '1' || linked === 'true') return { linked: true, error: null }
  return null
}

// ---------------------------------------------------------------------------
// Instance URLs
// ---------------------------------------------------------------------------

/** Convert an http(s) origin to ws(s) for bot-gateway WebSocket URLs. */
export function httpBaseToWsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '')
  if (normalized.startsWith('https://')) return `wss://${normalized.slice('https://'.length)}`
  if (normalized.startsWith('http://')) return `ws://${normalized.slice('http://'.length)}`
  return normalized
}

/** Public origin of this instance. Native clients carry it in the stored instance; the web app is served from it. */
export function resolveHarmonyBaseUrl(): string {
  const stored = getStoredInstance()
  if (stored?.origin) return stored.origin.replace(/\/$/, '')
  const fromEnv = runtimeConfig.appUrl
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  if (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)) return window.location.origin
  const domain = runtimeConfig.domain
  if (domain) return `https://${domain}`
  return 'https://your-harmony-instance.example'
}

/** This instance's display name: its configured name, else its domain. */
export function resolveInstanceName(): string {
  return getStoredInstance()?.name || runtimeConfig.instanceName || getInstanceDomain()
}

export interface BridgeGatewayUrls {
  gatewayUrl: string
  apiUrl: string
  baseUrl: string
}

export function buildBridgeGatewayUrls(baseUrl: string, coLocated: boolean): BridgeGatewayUrls {
  const normalizedBase = baseUrl.replace(/\/$/, '')
  if (coLocated) {
    return {
      gatewayUrl: 'ws://localhost:3002/gateway',
      apiUrl: 'http://localhost:3002',
      baseUrl: normalizedBase,
    }
  }
  return {
    gatewayUrl: `${httpBaseToWsUrl(normalizedBase)}/bot-gateway/gateway`,
    apiUrl: `${normalizedBase}/bot-gateway`,
    baseUrl: normalizedBase,
  }
}

// ---------------------------------------------------------------------------
// v1 config file (legacy bridges)
// ---------------------------------------------------------------------------

export interface BridgeConfigYamlInput {
  pairingCode: string
  serverId: string
  gateway: BridgeGatewayUrls
}

export function generateBridgeConfigYaml(input: BridgeConfigYamlInput): string {
  const { pairingCode, serverId, gateway } = input
  return `# Harmony Discord Bridge (v1) — generated setup
# Pairing code: ${pairingCode}
# Docs: https://github.com/y4my4my4m/harmony-discord-bridge

discord:
  token: "YOUR_DISCORD_BOT_TOKEN"
  guildId: "YOUR_DISCORD_SERVER_ID"

harmony:
  token: "YOUR_HARMONY_BOT_TOKEN"
  serverId: "${serverId}"
  pairingCode: "${pairingCode}"
  gatewayUrl: "${gateway.gatewayUrl}"
  apiUrl: "${gateway.apiUrl}"
  baseUrl: "${gateway.baseUrl}"

channelMappings:
  - discord: "DISCORD_CHANNEL_ID"
    harmony: "HARMONY_CHANNEL_UUID"
    bidirectional: true
    name: "general"

settings:
  syncAttachments: true
  syncReactions: true
  syncEdits: false
  syncDeletes: false
  mentionTranslation: true
  syncPresence: false
`
}

// ---------------------------------------------------------------------------
// v2 rows
// ---------------------------------------------------------------------------

export type BridgeMode = 'self' | 'hosted' | 'instance'
export type PairDirection = 'both' | 'to_harmony' | 'to_discord'
export const PAIR_DIRECTIONS: readonly PairDirection[] = ['both', 'to_harmony', 'to_discord']

export const BRIDGE_SETTING_KEYS = [
  'sync_member_list',
  'sync_presence',
  'sync_reactions',
  'sync_edits',
  'sync_deletes',
] as const
export type BridgeSettingKey = (typeof BRIDGE_SETTING_KEYS)[number]
export type BridgeSettings = Record<BridgeSettingKey, boolean>

/** discord_bridges.settings column default. */
export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  sync_member_list: true,
  sync_presence: false,
  sync_reactions: true,
  sync_edits: true,
  sync_deletes: true,
}

export function normalizeBridgeSettings(raw: unknown): BridgeSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const settings = { ...DEFAULT_BRIDGE_SETTINGS }
  for (const key of BRIDGE_SETTING_KEYS) {
    if (typeof source[key] === 'boolean') settings[key] = source[key] as boolean
  }
  return settings
}

/** discord_bridges row. snapshot and status are stored as the bridge reported them. */
export interface DiscordBridgeRow {
  id: string
  server_id: string
  bot_id: string | null
  mode: BridgeMode
  discord_guild_id: string | null
  discord_guild_name: string | null
  discord_application_id: string | null
  discord_bot_name: string | null
  settings: unknown
  snapshot: unknown
  status: unknown
  bridge_version: string | null
  last_seen_at: string | null
  created_by?: string | null
  created_at?: string
  updated_at?: string
}

/** discord_bridge_channels row. */
export interface BridgePairRow {
  id: string
  bridge_id: string
  harmony_channel_id: string
  discord_channel_id: string
  discord_channel_name: string | null
  direction: PairDirection
  created_at?: string
}

export interface HarmonyChannelOption {
  id: string
  name: string
  categoryName: string | null
}

// ---------------------------------------------------------------------------
// Status and snapshot (POST /bridge/v2/status)
// ---------------------------------------------------------------------------

export interface BridgeProblem {
  code: string
  params: Record<string, string>
}

export type DiscordIntent = 'message_content' | 'members' | 'presence'
export const DISCORD_INTENTS: readonly DiscordIntent[] = ['message_content', 'members', 'presence']

export interface BridgeStatus {
  discordConnected: boolean | null
  applicationId: string | null
  botName: string | null
  intents: Record<DiscordIntent, boolean | null>
  harmonyConnected: boolean | null
  problems: BridgeProblem[]
}

export interface SnapshotChannel {
  id: string
  name: string
  type: number
  parentId: string | null
  position: number
  canView: boolean
  canSend: boolean
  canManageWebhooks: boolean
}

export interface SnapshotGuild {
  id: string
  name: string
  icon: string | null
  channels: SnapshotChannel[]
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const asBool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
const asString = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null

export function parseBridgeStatus(raw: unknown): BridgeStatus {
  const status = asRecord(raw)
  const discord = asRecord(status.discord)
  const intents = asRecord(discord.intents)
  const botUser = asRecord(discord.bot_user)
  const harmony = asRecord(status.harmony)
  const problems = Array.isArray(status.problems) ? status.problems : []
  return {
    discordConnected: asBool(discord.connected),
    applicationId: asString(discord.application_id),
    botName: asString(botUser.name),
    intents: {
      message_content: asBool(intents.message_content),
      members: asBool(intents.members),
      presence: asBool(intents.presence),
    },
    harmonyConnected: asBool(harmony.connected),
    problems: problems
      .map((p): BridgeProblem | null => {
        const entry = asRecord(p)
        const code = asString(entry.code)
        if (!code) return null
        const params: Record<string, string> = {}
        for (const [key, value] of Object.entries(asRecord(entry.params))) {
          const text = asString(value)
          if (text) params[key] = text
        }
        return { code, params }
      })
      .filter((p): p is BridgeProblem => p !== null),
  }
}

/** Accepts the stored snapshot as {guilds:[...]} or as the bare guild array. */
export function parseSnapshotGuilds(raw: unknown): SnapshotGuild[] {
  const list = Array.isArray(raw) ? raw : asRecord(raw).guilds
  if (!Array.isArray(list)) return []
  return list
    .map((g): SnapshotGuild | null => {
      const guild = asRecord(g)
      const id = asString(guild.id)
      if (!id) return null
      const channels = Array.isArray(guild.channels) ? guild.channels : []
      return {
        id,
        name: asString(guild.name) ?? id,
        icon: asString(guild.icon),
        channels: channels
          .map((c): SnapshotChannel | null => {
            const channel = asRecord(c)
            const channelId = asString(channel.id)
            if (!channelId) return null
            return {
              id: channelId,
              name: asString(channel.name) ?? channelId,
              type: typeof channel.type === 'number' ? channel.type : 0,
              parentId: asString(channel.parent_id),
              position: typeof channel.position === 'number' ? channel.position : 0,
              canView: channel.can_view === true,
              canSend: channel.can_send === true,
              canManageWebhooks: channel.can_manage_webhooks === true,
            }
          })
          .filter((c): c is SnapshotChannel => c !== null),
      }
    })
    .filter((g): g is SnapshotGuild => g !== null)
}

/** Discord channel types a bridge relays: GUILD_TEXT (0) and GUILD_ANNOUNCEMENT (5). */
export const DISCORD_TEXT_CHANNEL_TYPES = [0, 5]
/** GUILD_CATEGORY. */
export const DISCORD_CATEGORY_CHANNEL_TYPE = 4

export interface DiscordChannelGroup {
  categoryName: string | null
  channels: SnapshotChannel[]
}

/** Text channels grouped under their category, both in Discord's sidebar order. */
export function groupDiscordTextChannels(guild: SnapshotGuild | null | undefined): DiscordChannelGroup[] {
  if (!guild) return []
  const byPosition = (a: SnapshotChannel, b: SnapshotChannel) => a.position - b.position || a.name.localeCompare(b.name)
  const categories = guild.channels.filter((c) => c.type === DISCORD_CATEGORY_CHANNEL_TYPE).sort(byPosition)
  const text = guild.channels.filter((c) => DISCORD_TEXT_CHANNEL_TYPES.includes(c.type)).sort(byPosition)
  const groups: DiscordChannelGroup[] = []
  const loose = text.filter((c) => !c.parentId || !categories.some((cat) => cat.id === c.parentId))
  if (loose.length) groups.push({ categoryName: null, channels: loose })
  for (const category of categories) {
    const channels = text.filter((c) => c.parentId === category.id)
    if (channels.length) groups.push({ categoryName: category.name, channels })
  }
  return groups
}

// ---------------------------------------------------------------------------
// Liveness, checklist, problems
// ---------------------------------------------------------------------------

/** Three 30 s heartbeats. */
export const BRIDGE_STALE_MS = 90_000

export function isBridgeOnline(lastSeenAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return false
  const seen = Date.parse(lastSeenAt)
  return Number.isFinite(seen) && now - seen <= BRIDGE_STALE_MS
}

/** Message Content always; Server Members with member list sync; Presence with presence sync. */
export function requiredIntents(settings: BridgeSettings): DiscordIntent[] {
  const intents: DiscordIntent[] = ['message_content']
  if (settings.sync_member_list) intents.push('members')
  if (settings.sync_presence) intents.push('presence')
  return intents
}

export type CheckKey = 'bridge' | 'token' | 'intents' | 'invited' | 'harmony'
export type CheckState = 'ok' | 'fail' | 'waiting'
export interface CheckItem {
  key: CheckKey
  state: CheckState
}

const hasProblem = (problems: BridgeProblem[], ...codes: string[]) => problems.some((p) => codes.includes(p.code))

export function buildChecklist(bridge: DiscordBridgeRow, now = Date.now()): CheckItem[] {
  if (!bridge.last_seen_at) {
    return (['bridge', 'token', 'intents', 'invited', 'harmony'] as CheckKey[]).map((key) => ({ key, state: 'waiting' }))
  }
  const online = isBridgeOnline(bridge.last_seen_at, now)
  if (!online) {
    return [
      { key: 'bridge', state: 'fail' },
      ...(['token', 'intents', 'invited', 'harmony'] as CheckKey[]).map((key) => ({ key, state: 'waiting' as CheckState })),
    ]
  }
  const status = parseBridgeStatus(bridge.status)
  const settings = normalizeBridgeSettings(bridge.settings)
  const guilds = parseSnapshotGuilds(bridge.snapshot)
  const { problems } = status

  let token: CheckState = 'waiting'
  if (hasProblem(problems, 'discord_token_invalid')) token = 'fail'
  else if (status.discordConnected) token = 'ok'

  let intents: CheckState = 'waiting'
  const needed = requiredIntents(settings)
  // Reported intents mean something only once Discord accepted the token.
  if (hasProblem(problems, 'intent_missing')) intents = 'fail'
  else if (status.discordConnected && needed.some((i) => status.intents[i] === false)) intents = 'fail'
  else if (status.discordConnected) intents = 'ok'

  let invited: CheckState = 'waiting'
  if (hasProblem(problems, 'no_guild', 'bot_not_in_guild')) invited = 'fail'
  else if (guilds.length > 0) invited = 'ok'
  else if (status.discordConnected) invited = 'fail'

  let harmony: CheckState = 'waiting'
  if (hasProblem(problems, 'harmony_auth_failed', 'harmony_unreachable')) harmony = 'fail'
  else if (status.harmonyConnected) harmony = 'ok'
  else if (status.harmonyConnected === false) harmony = 'fail'

  return [
    { key: 'bridge', state: 'ok' },
    { key: 'token', state: token },
    { key: 'intents', state: intents },
    { key: 'invited', state: invited },
    { key: 'harmony', state: harmony },
  ]
}

/**
 * Problems to show, in the bridge's order. An offline bridge leads with `bridge_offline`;
 * a needed intent reported as off without an intent_missing entry gets one; a bot in no
 * guild gets `no_guild`. Duplicates (same code and params) collapse.
 */
export function collectProblems(bridge: DiscordBridgeRow, now = Date.now()): BridgeProblem[] {
  if (!bridge.last_seen_at) return []
  const status = parseBridgeStatus(bridge.status)
  const out: BridgeProblem[] = []
  if (!isBridgeOnline(bridge.last_seen_at, now)) out.push({ code: 'bridge_offline', params: {} })
  out.push(...status.problems)
  if (status.discordConnected) {
    const settings = normalizeBridgeSettings(bridge.settings)
    for (const intent of requiredIntents(settings)) {
      if (status.intents[intent] === false) out.push({ code: 'intent_missing', params: { intent } })
    }
    const guilds = parseSnapshotGuilds(bridge.snapshot)
    if (bridge.mode === 'instance') {
      // The stored snapshot of an instance bridge holds its linked guild alone, when the bot is in
      // it. Linking another guild clears the snapshot until the bridge reports again.
      if (bridge.discord_guild_id && bridge.snapshot && !guilds.some((g) => g.id === bridge.discord_guild_id)) {
        out.push({ code: 'bot_not_in_guild', params: { guild_id: bridge.discord_guild_id } })
      }
    } else if (guilds.length === 0) {
      out.push({ code: 'no_guild', params: {} })
    }
  }
  const seen = new Set<string>()
  return out.filter((p) => {
    const key = `${p.code}:${JSON.stringify(p.params)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------
// Setup steps
// ---------------------------------------------------------------------------

export const SETUP_STEPS = ['bot', 'connect', 'check', 'guild', 'channels', 'options'] as const
/** The instance bot: Add to Discord links the guild; the instance runs the bridge. */
export const INSTANCE_SETUP_STEPS = ['link', 'channels', 'options'] as const
export type SetupStep = (typeof SETUP_STEPS)[number] | (typeof INSTANCE_SETUP_STEPS)[number]

export function setupStepsFor(mode: BridgeMode): readonly SetupStep[] {
  return mode === 'instance' ? INSTANCE_SETUP_STEPS : SETUP_STEPS
}

/**
 * The first step that still needs the admin, from the row alone. A bridge that never
 * reported in is at 'bot' unless the admin moved on to 'connect' (or saved a hosted
 * token, 'check'); after that the checklist, the guild and the first pair gate. An
 * instance bridge is at 'link' until a guild is linked, then the first pair gates.
 */
export function deriveSetupStep(
  bridge: DiscordBridgeRow,
  pairCount: number,
  now = Date.now(),
  reached: SetupStep | null = null,
): SetupStep {
  if (bridge.mode === 'instance') {
    if (!bridge.discord_guild_id) return 'link'
    return pairCount === 0 ? 'channels' : 'options'
  }
  if (!bridge.last_seen_at) {
    if (reached === 'check') return 'check'
    return reached === 'connect' ? 'connect' : 'bot'
  }
  if (buildChecklist(bridge, now).some((item) => item.state !== 'ok')) return 'check'
  if (!bridge.discord_guild_id) return 'guild'
  if (pairCount === 0) return 'channels'
  return 'options'
}

// ---------------------------------------------------------------------------
// Self-hosted commands
// ---------------------------------------------------------------------------

export const BRIDGE_IMAGE = 'ghcr.io/y4my4my4m/harmony-discord-bridge:latest'
export const BRIDGE_CONTAINER = 'harmony-discord-bridge'
export const BRIDGE_VOLUME = 'harmony-bridge-data'
/** Contains no shell metacharacters, so a pasted command that still holds it fails at Discord login, not in the shell. */
export const DISCORD_TOKEN_PLACEHOLDER = 'PASTE_YOUR_DISCORD_BOT_TOKEN_HERE'
/** discord_bridge_setup_codes.expires_at is 30 minutes after issue. */
export const SETUP_CODE_TTL_MS = 30 * 60 * 1000

export interface BridgeCommandInput {
  harmonyUrl: string
  setupCode: string
}

/** One line: cmd.exe and PowerShell have no backslash continuation. */
export function buildDockerRunCommand({ harmonyUrl, setupCode }: BridgeCommandInput): string {
  return [
    'docker run -d',
    `--name ${BRIDGE_CONTAINER}`,
    '--restart unless-stopped',
    `-e HARMONY_URL=${harmonyUrl}`,
    `-e HARMONY_SETUP_CODE=${setupCode}`,
    `-e DISCORD_TOKEN=${DISCORD_TOKEN_PLACEHOLDER}`,
    `-v ${BRIDGE_VOLUME}:/data`,
    BRIDGE_IMAGE,
  ].join(' ')
}

export function buildDockerCompose({ harmonyUrl, setupCode }: BridgeCommandInput): string {
  return `services:
  ${BRIDGE_CONTAINER}:
    image: ${BRIDGE_IMAGE}
    container_name: ${BRIDGE_CONTAINER}
    restart: unless-stopped
    environment:
      HARMONY_URL: "${harmonyUrl}"
      HARMONY_SETUP_CODE: "${setupCode}"
      DISCORD_TOKEN: "${DISCORD_TOKEN_PLACEHOLDER}"
    volumes:
      - ${BRIDGE_VOLUME}:/data

volumes:
  ${BRIDGE_VOLUME}:
`
}

export const BRIDGE_LOGS_COMMAND = `docker logs --tail 50 ${BRIDGE_CONTAINER}`
export const BRIDGE_START_COMMAND = `docker start ${BRIDGE_CONTAINER}`
export const BRIDGE_RESTART_COMMAND = `docker restart ${BRIDGE_CONTAINER}`
/** Removes the container and its saved Harmony credentials so a new setup code is redeemed. */
export const BRIDGE_RESET_COMMAND = `docker rm -f ${BRIDGE_CONTAINER} && docker volume rm ${BRIDGE_VOLUME}`
export const BRIDGE_REMOVE_COMMAND = `docker rm -f ${BRIDGE_CONTAINER}`

// ---------------------------------------------------------------------------
// Hosted token input
// ---------------------------------------------------------------------------

export type TokenIssue = 'empty' | 'applicationId' | 'publicKey' | 'clientSecret' | 'harmonyToken' | 'notToken'

/**
 * Discord bot tokens are three dot-separated base64url segments. The other values on
 * the Developer Portal pages are recognised so the error names what was pasted.
 */
export function checkDiscordToken(input: string): { token: string; issue: TokenIssue | null } {
  const token = input.trim().replace(/^bot\s+/i, '').replace(/^["']|["']$/g, '').trim()
  if (!token) return { token, issue: 'empty' }
  if (token.startsWith('harmony_bot_')) return { token, issue: 'harmonyToken' }
  if (/^\d{15,25}$/.test(token)) return { token, issue: 'applicationId' }
  if (/^[0-9a-f]{64}$/i.test(token)) return { token, issue: 'publicKey' }
  if (/^[A-Za-z0-9_-]{32}$/.test(token)) return { token, issue: 'clientSecret' }
  if (!/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(token)) return { token, issue: 'notToken' }
  return { token, issue: null }
}

// ---------------------------------------------------------------------------
// Channel pairing
// ---------------------------------------------------------------------------

export type ChannelIssue = 'not_visible' | 'cannot_send' | 'cannot_manage_webhooks'

/** What keeps a Discord channel from working in the given direction. Harmony→Discord needs Send Messages; webhooks give senders their own name and avatar. */
export function discordChannelIssues(channel: SnapshotChannel, direction: PairDirection): ChannelIssue[] {
  if (!channel.canView) return ['not_visible']
  if (direction === 'to_harmony') return []
  const issues: ChannelIssue[] = []
  if (!channel.canSend) issues.push('cannot_send')
  if (!channel.canManageWebhooks) issues.push('cannot_manage_webhooks')
  return issues
}

/** Blocking issues stop a pair from being added; a missing webhook permission only degrades it. */
export function isBlockingIssue(issue: ChannelIssue): boolean {
  return issue !== 'cannot_manage_webhooks'
}

/** Lowercase letters and digits joined by '-': "💬 General Chat" and "general-chat" match. */
export function normalizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

export interface NameMatch {
  harmony: HarmonyChannelOption
  discord: SnapshotChannel
}

/** Unpaired channels whose normalized names are equal and unique on both sides; Discord side must be visible to the bot. */
export function matchChannelsByName(
  harmonyChannels: HarmonyChannelOption[],
  discordChannels: SnapshotChannel[],
  pairs: Pick<BridgePairRow, 'harmony_channel_id' | 'discord_channel_id'>[],
): NameMatch[] {
  const pairedHarmony = new Set(pairs.map((p) => p.harmony_channel_id))
  const pairedDiscord = new Set(pairs.map((p) => p.discord_channel_id))
  const index = <T>(items: T[], name: (item: T) => string) => {
    const map = new Map<string, T[]>()
    for (const item of items) {
      const key = normalizeChannelName(name(item))
      if (!key) continue
      map.set(key, [...(map.get(key) ?? []), item])
    }
    return map
  }
  const harmony = index(harmonyChannels.filter((c) => !pairedHarmony.has(c.id)), (c) => c.name)
  const discord = index(
    discordChannels.filter((c) => DISCORD_TEXT_CHANNEL_TYPES.includes(c.type) && !pairedDiscord.has(c.id)),
    (c) => c.name,
  )
  const matches: NameMatch[] = []
  for (const [key, hs] of harmony) {
    const ds = discord.get(key)
    if (hs.length !== 1 || ds?.length !== 1 || !ds[0].canView) continue
    matches.push({ harmony: hs[0], discord: ds[0] })
  }
  return matches
}
