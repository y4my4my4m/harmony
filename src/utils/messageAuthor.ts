import type { Message, MessageRemoteAuthor, MessageWebhookAuthor } from '@/types'

/**
 * Message authored via an external bridge (Discord, etc.), not a native Harmony user row.
 * bridge_source 'harmony' marks a Harmony-origin message the bridge relayed out
 * (bot-gateway BotRestAPI BRIDGE_MAPPING_KEYS); its author is the Harmony user.
 */
export function isBridgedAuthorMessage(message: Message | null | undefined): boolean {
  const source = message?.metadata?.bridge_source
  return !!(message?.metadata?.discord_user || (source && source !== 'harmony'))
}

export function getBridgeSource(message: Message | null | undefined): string | null {
  if (!isBridgedAuthorMessage(message)) return null
  return message?.metadata?.bridge_source ?? (message?.metadata?.discord_user ? 'discord' : null)
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
 * Name and avatar of an author with no Harmony profile: a bridged Discord person, a channel
 * webhook, a remote bot (getRemoteAuthor), or a bot (joined as `bot`). Null for a message a
 * profile wrote.
 */
export function getForeignAuthor(message: Message | null | undefined): { name: string; avatar_url: string | null } | null {
  const discord = message?.metadata?.discord_user
  if (discord && typeof discord === 'object') {
    const name = discord.display_name || discord.username
    return { name: typeof name === 'string' && name ? name : 'Discord user', avatar_url: discord.avatar_url || null }
  }
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
 * relays many Discord people through one bot, a webhook posts under per-message names, and a
 * copy's Group speaks for every bot of its host.
 */
export function messageAuthorKey(message: Message | null | undefined): string {
  if (!message) return ''
  const discord = message.metadata?.discord_user
  if (discord && typeof discord === 'object') return `discord:${discord.id || discord.username || ''}`
  const webhook = getWebhookAuthor(message)
  if (webhook) return `webhook:${webhook.id}\n${webhook.name}\n${webhook.avatar_url ?? ''}`
  const remote = getRemoteAuthor(message)
  if (remote) return `${remote.kind}:${remote.id}\n${remote.name}\n${remote.avatar_url ?? ''}`
  if (message.bot_id) return `bot:${message.bot_id}`
  return `user:${message.user_id ?? ''}`
}
