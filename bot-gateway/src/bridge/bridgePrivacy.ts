import { supabase } from '../config/supabase.js'

/** A missing migration or malformed answer must never disclose a member's messages. */
async function allowedIds(rpc: string, args: Record<string, unknown>, requested: string[]): Promise<Set<string>> {
  if (requested.length === 0) return new Set()
  const { data, error } = await supabase.rpc(rpc, args)
  if (error || !Array.isArray(data) || data.some(id => typeof id !== 'string' || !requested.includes(id))) {
    throw new Error('Bridge privacy status unavailable')
  }
  return new Set(data)
}

export function visibleMessageIds(botId: string, messageIds: string[]): Promise<Set<string>> {
  return allowedIds('bridge_visible_message_ids', { p_bot_id: botId, p_message_ids: messageIds }, messageIds)
}

export async function messageRecipients(botIds: string[], messageId: string): Promise<string[]> {
  const allowed = await allowedIds('bridge_message_recipients', { p_bot_ids: botIds, p_message_id: messageId }, botIds)
  return botIds.filter(id => allowed.has(id))
}

export async function memberRecipients(botIds: string[], channelId: string, userId: string | null): Promise<string[]> {
  const allowed = await allowedIds('bridge_member_recipients', { p_bot_ids: botIds, p_channel_id: channelId, p_user_id: userId }, botIds)
  return botIds.filter(id => allowed.has(id))
}

export interface MessagePrivacySource {
  user_id?: string | null
  bot_id?: string | null
  metadata?: unknown
}

/** Retain attribution, not message content or unrelated metadata, across hard deletes. */
export function messagePrivacySource(source: MessagePrivacySource | null | undefined): MessagePrivacySource | null {
  if (!source || source.user_id === undefined || source.bot_id === undefined || source.metadata === undefined) return null
  const metadata = source.metadata
  if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) return null
  const hasInteraction = !!metadata && Object.hasOwn(metadata, 'interaction')
  const interaction = hasInteraction ? (metadata as Record<string, unknown>).interaction : undefined
  return {
    user_id: source.user_id ?? null,
    bot_id: source.bot_id ?? null,
    metadata: hasInteraction ? {
      interaction: interaction && typeof interaction === 'object' && !Array.isArray(interaction)
        ? { user_id: (interaction as Record<string, unknown>).user_id ?? null } : null,
    } : {},
  }
}

export async function sourceRecipients(botIds: string[], channelId: string, source: MessagePrivacySource | null | undefined): Promise<string[]> {
  const allowed = await allowedIds('bridge_source_recipients', {
    p_bot_ids: botIds, p_channel_id: channelId, p_source: messagePrivacySource(source),
  }, botIds)
  return botIds.filter(id => allowed.has(id))
}

export async function bridgeChannelPlatform(botId: string, channelId: string): Promise<'matrix' | 'discord' | null> {
  const { data, error } = await supabase.rpc('bridge_channel_platform', { p_bot_id: botId, p_channel_id: channelId })
  if (error || (data !== null && data !== 'matrix' && data !== 'discord')) throw new Error('Bridge registration unavailable')
  return data
}
