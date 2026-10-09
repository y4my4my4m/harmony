import { supabase } from '@/supabase'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import type { Message } from '@/types'

/** Whether the message hides its embeds for every viewer (metadata.suppress_embeds). */
export function embedsSuppressed(message: Message | null | undefined): boolean {
  return (message as { metadata?: { suppress_embeds?: unknown } } | null | undefined)?.metadata?.suppress_embeds === true
}

/** Whether the message has anything an embed renders from: link or embed parts. */
export function hasEmbeddableParts(message: Message | null | undefined): boolean {
  const content = (message as { content?: unknown } | null | undefined)?.content
  return Array.isArray(content)
    && content.some((p) => p && typeof p === 'object' && ((p as { type?: string }).type === 'url' || (p as { type?: string }).type === 'embed'))
}

/**
 * Hides or restores a message's embeds for every viewer (set_message_embeds_suppressed: the
 * author, or MANAGE_MESSAGES in its server channel). The loaded copies take the new metadata
 * at once; the row's realtime update carries it to other clients.
 */
export async function setEmbedsSuppressed(message: Message, suppressed: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_message_embeds_suppressed', {
    p_message_id: message.id,
    p_suppressed: suppressed,
  })
  if (error) throw error

  const current = (message as { metadata?: Record<string, unknown> }).metadata
  const metadata: Record<string, unknown> = { ...(current && typeof current === 'object' ? current : {}) }
  if (suppressed) metadata.suppress_embeds = true
  else delete metadata.suppress_embeds
  const fields = { metadata } as Partial<Message>
  Object.assign(message, fields)
  useChatStore().patchMessageFields(message.id, fields)
  useDMStore().patchMessageFields(message.id, fields)
}
