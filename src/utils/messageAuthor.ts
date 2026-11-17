import type { BridgeAuthor, BridgePlatform, Message, MessageRemoteAuthor, MessageWebhookAuthor } from '@/types'
import { parseMatrixId } from '@/utils/matrixMentions'

/** Metadata key of a relayed person on messages and reactions, per platform. */
export const BRIDGE_AUTHOR_KEYS: Readonly<Record<BridgePlatform, 'discord_user' | 'matrix_user'>> = {
  discord: 'discord_user',
  matrix: 'matrix_user',
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Keyed by the metadata object; a replaced metadata object is read afresh. */
const authorCache = new WeakMap<object, BridgeAuthor | null>()

function readBridgedAuthor(metadata: Record<string, unknown>): BridgeAuthor | null {
  for (const platform of ['discord', 'matrix'] as const) {
    const raw = metadata[BRIDGE_AUTHOR_KEYS[platform]]
    if (!raw || typeof raw !== 'object') continue
    const person = raw as Record<string, unknown>
    // A Matrix person is keyed by MXID; a Discord row without an id predates the bridge's id field.
    if (platform === 'matrix' && !str(person.id)) continue
    return {
      platform,
      id: str(person.id),
      username: str(person.username),
      display_name: str(person.display_name) || undefined,
      avatar_url: str(person.avatar_url) || undefined,
    }
  }
  return null
}

/** The relayed person of a message, reaction or reaction actor: metadata.discord_user or metadata.matrix_user. */
export function getBridgedAuthor(value: { metadata?: Record<string, unknown> | null } | null | undefined): BridgeAuthor | null {
  const metadata = value?.metadata
  if (!metadata || typeof metadata !== 'object') return null
  const cached = authorCache.get(metadata)
  if (cached !== undefined) return cached
  const author = readBridgedAuthor(metadata)
  authorCache.set(metadata, author)
  return author
}

/** Platform name as the platform writes it; not translated. */
export function bridgePlatformLabel(platform: string): string {
  if (platform === 'discord') return 'Discord'
  if (platform === 'matrix') return 'Matrix'
  return platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : ''
}

/** Shown name: display name, else username (Matrix: else the MXID localpart). */
export function bridgedAuthorName(author: Pick<BridgeAuthor, 'platform' | 'id' | 'username' | 'display_name'>): string {
  const name = author.display_name?.trim() || author.username?.trim()
  if (name) return name
  if (author.platform === 'matrix') return parseMatrixId(author.id)?.username || author.id
  return 'Discord user'
}

/** Handle line: Discord `@username`, Matrix the full MXID. */
export function bridgedAuthorHandle(author: Pick<BridgeAuthor, 'platform' | 'id' | 'username'>): string {
  if (author.platform === 'matrix') return author.id
  const username = author.username.replace(/^@+/, '')
  return username ? `@${username}` : ''
}

/**
 * Message authored via an external bridge (Discord, Matrix), not a native Harmony user row.
 * bridge_source 'harmony' marks a Harmony-origin message the bridge relayed out
 * (bot-gateway BotRestAPI BRIDGE_MAPPING_KEYS); its author is the Harmony user.
 */
export function isBridgedAuthorMessage(message: Message | null | undefined): boolean {
  const source = message?.metadata?.bridge_source
  return !!(getBridgedAuthor(message) || (source && source !== 'harmony'))
}

export function getBridgeSource(message: Message | null | undefined): string | null {
  if (!isBridgedAuthorMessage(message)) return null
  return getBridgedAuthor(message)?.platform ?? message?.metadata?.bridge_source ?? null
}

/** Profile UUID for DisplayName lookups; empty when author is bridged or bot-only. */
export function getHarmonyProfileUserId(message: Message | null | undefined): string {
  if (!message?.user_id || message.bot_id || isBridgedAuthorMessage(message)) return ''
  return message.user_id
}

const REMOTE_AUTHOR_KINDS = new Set(['bot', 'webhook', 'bridge'])

/**
 * The author of a message in a copy of a federated server that no profile wrote: a bot, a
 * channel webhook or a bridged person, for whom the host's Group speaks (federation-backend
 * activitypub/groupAuthor.ts). metadata.remote_author is reserved for the server
 * (guard_message_client_write); the row has neither user_id nor bot_id.
 */
export function getRemoteAuthor(message: Message | null | undefined): MessageRemoteAuthor | null {
  if (!message || message.user_id || message.bot_id) return null
  const remote = message.metadata?.remote_author
  if (!remote || typeof remote !== 'object' || !REMOTE_AUTHOR_KINDS.has(remote.kind)) return null
  if (typeof remote.name !== 'string' || !remote.name) return null
  return {
    kind: remote.kind,
    id: typeof remote.id === 'string' ? remote.id : '',
    name: remote.name,
    avatar_url: typeof remote.avatar_url === 'string' && remote.avatar_url ? remote.avatar_url : null,
  }
}

/**
 * The shown author of a message a channel webhook posted: metadata.webhook, written by
 * execute_channel_webhook and reserved for the server, or in a copy the webhook its host
 * names (getRemoteAuthor). Null for any other message.
 */
export function getWebhookAuthor(message: Message | null | undefined): MessageWebhookAuthor | null {
  const remote = getRemoteAuthor(message)
  if (remote?.kind === 'webhook') return { id: remote.id, name: remote.name, avatar_url: remote.avatar_url }
  const webhook = message?.bot_id ? message.metadata?.webhook : null
  if (!webhook || typeof webhook !== 'object' || typeof webhook.name !== 'string' || !webhook.name) return null
  return {
    id: typeof webhook.id === 'string' ? webhook.id : '',
    name: webhook.name,
    avatar_url: typeof webhook.avatar_url === 'string' && webhook.avatar_url ? webhook.avatar_url : null,
  }
}

/**
 * Name and avatar of an author with no Harmony profile: a bridged person, a channel
 * webhook, a remote bot (getRemoteAuthor), or a bot (joined as `bot`). Null for a message a
 * profile wrote.
 */
export function getForeignAuthor(message: Message | null | undefined): { name: string; avatar_url: string | null } | null {
  const bridged = getBridgedAuthor(message)
  if (bridged) return { name: bridgedAuthorName(bridged), avatar_url: bridged.avatar_url || null }
  const webhook = getWebhookAuthor(message)
  if (webhook) return { name: webhook.name, avatar_url: webhook.avatar_url }
  const remote = getRemoteAuthor(message)
  if (remote) return { name: remote.name, avatar_url: remote.avatar_url }
  if (message?.bot_id) {
    const bot = (message as Message & { bot?: { display_name?: string; username?: string; avatar_url?: string | null } }).bot
    return { name: bot?.display_name || bot?.username || 'Bot', avatar_url: bot?.avatar_url ?? null }
  }
  return null
}

/** A bot wrote it: a local bot row, or in a copy a bot its host names. */
export function isBotAuthorMessage(message: Message | null | undefined): boolean {
  return !!message?.bot_id || !!getRemoteAuthor(message)
}

/**
 * Who a message is shown as, for grouping consecutive messages under one header. A bridge
 * relays many people through one bot, a webhook posts under per-message names, and a
 * copy's Group speaks for every bot of its host.
 */
export function messageAuthorKey(message: Message | null | undefined): string {
  if (!message) return ''
  const bridged = getBridgedAuthor(message)
  if (bridged) return `${bridged.platform}:${bridged.id || bridged.username || ''}`
  const webhook = getWebhookAuthor(message)
  if (webhook) return `webhook:${webhook.id}\n${webhook.name}\n${webhook.avatar_url ?? ''}`
  const remote = getRemoteAuthor(message)
  if (remote) return `${remote.kind}:${remote.id}\n${remote.name}\n${remote.avatar_url ?? ''}`
  if (message.bot_id) return `bot:${message.bot_id}`
  return `user:${message.user_id ?? ''}`
}
