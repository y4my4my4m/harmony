/**
 * Read state. The database computes unread counts from read markers; clients never write
 * counts. Rows from get_unread_counts keep the shape unread_counts had, plus `muted`.
 *
 * Marking a channel or conversation read also marks its notifications read
 * (20261011100001); the loaded notification rows are updated here, since their
 * per-row broadcasts do not arrive while realtime is down.
 *
 * db_schema/migrations/20261005700001_compute_unread_on_read.sql
 * db_schema/migrations/20261011100001_unread_badge_fixes.sql
 */

import { supabase } from '@/supabase'
import type { UnreadCount } from '@/types'

async function applyNotificationsRead(contextType: 'channel' | 'conversation', contextId: string): Promise<void> {
  const { useNotificationStore } = await import('@/stores/useNotification')
  useNotificationStore().applyContextRead(contextType, contextId)
}

/** The caller's channels and conversations with unread messages or mentions. */
export async function fetchUnreadCounts(): Promise<UnreadCount[]> {
  const { data, error } = await supabase.rpc('get_unread_counts')
  if (error) throw new Error(error.message)
  return (data ?? []) as UnreadCount[]
}

/**
 * Marks a channel read with its notifications. `messageId` positions the next
 * "New messages" divider.
 */
export async function markChannelRead(channelId: string, messageId?: string | null): Promise<void> {
  const { error } = await supabase.rpc('mark_channel_as_read', {
    p_channel_id: channelId,
    p_message_id: messageId ?? null,
  })
  if (error) throw new Error(error.message)
  await applyNotificationsRead('channel', channelId)
}

/**
 * Marks a conversation read with its notifications. `messageId` positions the next
 * "New messages" divider.
 */
export async function markConversationRead(conversationId: string, messageId?: string | null): Promise<void> {
  const { error } = await supabase.rpc('mark_conversation_as_read', {
    p_conversation_id: conversationId,
    p_message_id: messageId ?? null,
  })
  if (error) throw new Error(error.message)
  await applyNotificationsRead('conversation', conversationId)
}

/** Marks every channel of a server read, with the server's notifications. */
export async function markServerRead(serverId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_server_as_read', { p_server_id: serverId })
  if (error) throw new Error(error.message)
}
