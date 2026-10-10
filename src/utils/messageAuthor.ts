import type { Message, MessageWebhookAuthor } from '@/types'

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

/**
 * The shown author of a message a channel webhook posted: metadata.webhook, written by
 * execute_channel_webhook and reserved for the server. Null for any other message.
 */
export function getWebhookAuthor(message: Message | null | undefined): MessageWebhookAuthor | null {
  const webhook = message?.bot_id ? message.metadata?.webhook : null
  if (!webhook || typeof webhook !== 'object' || typeof webhook.name !== 'string' || !webhook.name) return null
  return {
    id: typeof webhook.id === 'string' ? webhook.id : '',
    name: webhook.name,
    avatar_url: typeof webhook.avatar_url === 'string' && webhook.avatar_url ? webhook.avatar_url : null,
  }
}
