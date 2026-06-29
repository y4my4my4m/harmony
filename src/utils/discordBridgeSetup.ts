/**
 * Shared helpers for Discord ↔ Harmony bridge self-host setup.
 * Used by Server Settings → Discord Bridge.
 */

/** Discord OAuth2 bot permission flags required for the bridge. */
export const DISCORD_BRIDGE_PERMISSION_FLAGS = {
  viewChannel: 1n << 10n,
  manageChannels: 1n << 4n,
  sendMessages: 1n << 11n,
  embedLinks: 1n << 14n,
  attachFiles: 1n << 15n,
  readMessageHistory: 1n << 16n,
  addReactions: 1n << 6n,
  manageWebhooks: 1n << 29n,
} as const

const REQUIRED_DISCORD_FLAGS = [
  DISCORD_BRIDGE_PERMISSION_FLAGS.viewChannel,
  DISCORD_BRIDGE_PERMISSION_FLAGS.sendMessages,
  DISCORD_BRIDGE_PERMISSION_FLAGS.readMessageHistory,
  DISCORD_BRIDGE_PERMISSION_FLAGS.addReactions,
  DISCORD_BRIDGE_PERMISSION_FLAGS.embedLinks,
  DISCORD_BRIDGE_PERMISSION_FLAGS.attachFiles,
  DISCORD_BRIDGE_PERMISSION_FLAGS.manageWebhooks,
] as const

const OPTIONAL_DISCORD_FLAGS = [
  DISCORD_BRIDGE_PERMISSION_FLAGS.manageChannels,
] as const

function sumFlags(flags: readonly bigint[]): string {
  return flags.reduce((acc, flag) => acc | flag, 0n).toString()
}

export const DISCORD_BRIDGE_PERMISSIONS_VALUE = sumFlags(REQUIRED_DISCORD_FLAGS)
export const DISCORD_BRIDGE_PERMISSIONS_WITH_CLONE_VALUE = sumFlags([
  ...REQUIRED_DISCORD_FLAGS,
  ...OPTIONAL_DISCORD_FLAGS,
])

export const DISCORD_BRIDGE_SCOPES = 'bot applications.commands'

export interface DiscordIntentItem {
  name: string
  required: boolean
  description: string
}

export const DISCORD_BRIDGE_INTENTS: DiscordIntentItem[] = [
  {
    name: 'Message Content Intent',
    required: true,
    description: 'Read message text from Discord (privileged intent — enable under Bot → Privileged Gateway Intents).',
  },
  {
    name: 'Server Members Intent',
    required: false,
    description: 'Needed for presence sync and richer member autocomplete (privileged).',
  },
  {
    name: 'Presence Intent',
    required: false,
    description: 'Mirror Discord online status in Harmony when syncPresence is enabled (privileged).',
  },
]

export interface HarmonyBotPermissionItem {
  key: string
  label: string
  required: boolean
  description: string
}

export const HARMONY_BRIDGE_BOT_PERMISSIONS: HarmonyBotPermissionItem[] = [
  {
    key: 'read_messages',
    label: 'Read Messages',
    required: true,
    description: 'Receive channel messages from Harmony.',
  },
  {
    key: 'send_messages',
    label: 'Send Messages',
    required: true,
    description: 'Post bridged messages into Harmony channels.',
  },
  {
    key: 'manage_channels',
    label: 'Manage Channels',
    required: false,
    description: 'Required for /bridge clone-server and /bridge link on the Harmony side.',
  },
]

export interface BridgeGatewayUrls {
  gatewayUrl: string
  apiUrl: string
  baseUrl: string
}

/** Convert an http(s) origin to ws(s) for bot-gateway WebSocket URLs. */
export function httpBaseToWsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '')
  if (normalized.startsWith('https://')) {
    return `wss://${normalized.slice('https://'.length)}`
  }
  if (normalized.startsWith('http://')) {
    return `ws://${normalized.slice('http://'.length)}`
  }
  return normalized
}

export function resolveHarmonyBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_APP_URL as string | undefined
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  if (typeof window !== 'undefined') return window.location.origin
  const domain = import.meta.env.VITE_DOMAIN as string | undefined
  if (domain) return `https://${domain}`
  return 'https://your-harmony-instance.example'
}

export function buildBridgeGatewayUrls(
  baseUrl: string,
  coLocated: boolean,
): BridgeGatewayUrls {
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

export function buildDiscordInviteUrl(
  clientId: string,
  options?: { includeClonePermissions?: boolean },
): string {
  const trimmed = clientId.trim()
  if (!trimmed) return ''
  const permissions = options?.includeClonePermissions
    ? DISCORD_BRIDGE_PERMISSIONS_WITH_CLONE_VALUE
    : DISCORD_BRIDGE_PERMISSIONS_VALUE
  const params = new URLSearchParams({
    client_id: trimmed,
    permissions,
    scope: DISCORD_BRIDGE_SCOPES,
  })
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`
}

export interface BridgeConfigYamlInput {
  pairingCode: string
  serverId: string
  gateway: BridgeGatewayUrls
  includeClonePermissions?: boolean
}

export function generateBridgeConfigYaml(input: BridgeConfigYamlInput): string {
  const { pairingCode, serverId, gateway } = input
  return `# Harmony Discord Bridge — generated setup
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
  syncPresence: true
`
}

export function isBridgeBot(bot: { bot_type?: string | null; username?: string | null }): boolean {
  if (bot.bot_type === 'bridge') return true
  const username = bot.username?.toLowerCase() ?? ''
  return /^discord[-_]?bridge$/.test(username)
}

export function defaultHarmonyBridgePermissions(): Record<string, boolean> {
  return {
    read_messages: true,
    send_messages: true,
    manage_channels: true,
    embed_links: true,
    attach_files: true,
    add_reactions: true,
    manage_messages: false,
    mention_everyone: false,
    kick_members: false,
    ban_members: false,
  }
}
