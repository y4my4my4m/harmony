/**
 * Server-side message search through public.search_messages.
 *
 * The RPC returns ids in result order plus the match count; the rows are then read from
 * messages under its RLS and decrypted where the client holds keys.
 */

import { supabase } from '@/supabase'
import type { Message } from '@/types'
import type { SearchRpcParams } from '@/utils/searchQuery'
import { debug } from '@/utils/debug'

interface SearchRow {
  message_id: string
  relevance: number
  channel_id: string | null
  conversation_id: string | null
  user_id: string | null
  created_at: string
  server_id: string | null
  total_count: number | null
  fuzzy: boolean | null
}

export interface MessageSearchPage {
  results: Message[]
  /** Match count up to 10,000; 10,001 stands for more. Null when the page came back empty past the end. */
  total: number | null
  /** No row matched the words; the rows are similar ones (search_messages' typo fallback). */
  fuzzy: boolean
  /** With `lead`: created_at of the match just before the page; null on the first page. */
  before?: Date | null
}

/** search_messages counts at most this many matches exactly. */
export const SEARCH_TOTAL_CAP = 10000

export class SearchService {
  /**
   * `lead` reads one match more, the one before the page, for its created_at: encrypted
   * results found on the device go between the pages by time (utils/searchMerge.ts).
   */
  async searchMessages(params: SearchRpcParams, options: { signal?: AbortSignal; lead?: boolean } = {}): Promise<MessageSearchPage> {
    const lead = !!options.lead && params.p_offset > 0
    const sent = lead ? { ...params, p_offset: params.p_offset - 1, p_limit: params.p_limit + 1 } : params
    let request = supabase.rpc('search_messages', { ...sent })
    if (options.signal) request = request.abortSignal(options.signal)
    const { data, error } = await request
    if (error) {
      debug.error('Search error:', error)
      throw new Error(error.message)
    }

    const all = (data || []) as SearchRow[]
    const rows = lead ? all.slice(1) : all
    const messages = await this.loadMessagesByIds(rows.map(r => r.message_id))
    const byId = new Map(messages.map(m => [m.id, m]))
    return {
      results: rows.map(r => byId.get(r.message_id)).filter((m): m is Message => m !== undefined),
      total: all.length > 0 ? Number(all[0].total_count ?? 0) : null,
      fuzzy: all.some(r => r.fuzzy === true),
      ...(options.lead ? { before: lead && all.length > 0 ? new Date(all[0].created_at) : null } : {}),
    }
  }

  private async loadMessagesByIds(messageIds: string[]): Promise<Message[]> {
    if (messageIds.length === 0) return []

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .in('id', messageIds)
      .or('is_deleted.is.null,is_deleted.eq.false')

    if (error) {
      debug.error('Failed to load messages:', error)
      throw error
    }

    const messages: Message[] = (data || []).map(msg => ({
      id: msg.id,
      created_at: new Date(msg.created_at),
      updated_at: msg.updated_at ? new Date(msg.updated_at) : undefined,
      channel_id: msg.channel_id,
      conversation_id: msg.conversation_id,
      thread_id: msg.thread_id ?? undefined,
      user_id: msg.user_id,
      bot_id: msg.bot_id,
      content: msg.content,
      reply_to: msg.reply_to,
      is_system: msg.is_system || false,
      is_pinned: msg.is_pinned || false,
      metadata: msg.metadata,
      reactions: [],
      encrypted: msg.encrypted || false,
      encryption_metadata: msg.encryption_metadata || undefined,
    }))

    if (!messages.some(m => m.encrypted || m.encryption_metadata)) return messages

    try {
      const { processMessageDecryption } = await import('@/utils/messageDecryption')
      return await processMessageDecryption(messages)
    } catch (decryptError) {
      debug.warn('Failed to decrypt search results:', decryptError)
      return messages
    }
  }
}

export const searchService = new SearchService()
