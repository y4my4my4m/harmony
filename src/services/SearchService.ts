/**
 * SearchService - Message search using PostgreSQL full-text search
 * 
 * Provides Discord-like search functionality with filters for:
 * - Channel(s)
 * - User/author
 * - Date range
 * - Media presence
 * - URL presence
 * - Server scope
 */

import { supabase } from '@/supabase'
import type { Message } from '@/types'
import { debug } from '@/utils/debug'

export interface MessageSearchFilters {
  query: string // Search text
  channelId?: string | string[] // Single or multiple channels
  userId?: string // From specific user
  conversationId?: string // DM conversation
  serverId?: string // Within specific server
  hasMedia?: boolean // Messages with file attachments
  hasUrl?: boolean // Messages containing URLs
  fromDate?: Date // Date range start
  toDate?: Date // Date range end
  limit?: number
  offset?: number
}

export interface MessageSearchResult {
  message_id: string
  relevance: number
  content_text: string
  channel_id: string | null
  conversation_id: string | null
  user_id: string
  created_at: string
}

export interface MessageSearchResponse {
  results: Message[]
  total?: number
  hasMore: boolean
}

export class SearchService {
  private static instance: SearchService
  private readonly DEFAULT_LIMIT = 50
  private readonly MAX_LIMIT = 100

  private constructor() {}

  static getInstance(): SearchService {
    if (!SearchService.instance) {
      SearchService.instance = new SearchService()
    }
    return SearchService.instance
  }

  /**
   * Search messages with filters
   */
  async searchMessages(
    filters: MessageSearchFilters,
    options: { signal?: AbortSignal } = {}
  ): Promise<MessageSearchResponse> {
    try {
      const { signal } = options

      // Validate query - allow empty string if filters are present
      if (filters.query === undefined || filters.query === null || typeof filters.query !== 'string') {
        // Only require query if no filters are present
        const hasFilters = filters.channelId || filters.userId || filters.conversationId || 
                          filters.serverId || filters.hasMedia !== undefined || 
                          filters.hasUrl !== undefined || filters.fromDate || filters.toDate
        if (!hasFilters) {
          throw new Error('Search query is required')
        }
      }

      // Normalize channel IDs
      let channelIds: string[] | null = null
      if (filters.channelId) {
        channelIds = Array.isArray(filters.channelId) 
          ? filters.channelId 
          : [filters.channelId]
      }

      // Prepare parameters
      const limit = Math.min(filters.limit || this.DEFAULT_LIMIT, this.MAX_LIMIT)
      const offset = filters.offset || 0

      // Convert dates to ISO strings for PostgreSQL
      const fromDate = filters.fromDate?.toISOString() || null
      const toDate = filters.toDate?.toISOString() || null

      debug.log('🔍 Searching messages:', {
        query: filters.query.substring(0, 50),
        channelIds: channelIds?.length || 0,
        userId: filters.userId,
        serverId: filters.serverId,
        hasMedia: filters.hasMedia,
        hasUrl: filters.hasUrl,
        limit,
        offset
      })

      if (signal?.aborted) {
        throw new Error('Search was aborted')
      }

      // Call PostgreSQL search function
      // Normalize query - use empty string if not provided (allows filter-only searches)
      const normalizedQuery = filters.query ? filters.query.trim() : ''
      
      const { data, error } = await supabase.rpc('search_messages', {
        p_query: normalizedQuery || null, // Pass null if empty string
        p_channel_id: filters.channelId && !Array.isArray(filters.channelId) ? filters.channelId : null,
        p_channel_ids: channelIds && channelIds.length > 0 ? channelIds : null,
        p_user_id: filters.userId || null,
        p_conversation_id: filters.conversationId || null,
        p_server_id: filters.serverId || null,
        p_has_media: filters.hasMedia ?? null,
        p_has_url: filters.hasUrl ?? null,
        p_from_date: fromDate,
        p_to_date: toDate,
        p_limit: limit + 1, // Fetch one extra to check if there are more
        p_offset: offset
      })

      if (error) {
        debug.error('❌ Search error:', error)
        throw new Error(`Search failed: ${error.message}`)
      }

      const searchResults = (data || []) as MessageSearchResult[]
      const hasMore = searchResults.length > limit
      const results = searchResults.slice(0, limit)

      // Load full message data for each result
      const messageIds = results.map(r => r.message_id)
      const messages = await this.loadMessagesByIds(messageIds)

      // Sort messages by relevance (maintain order from search results)
      const messageMap = new Map(messages.map(m => [m.id, m]))
      const sortedMessages = results
        .map(r => messageMap.get(r.message_id))
        .filter((m): m is Message => m !== undefined)

      debug.log(`✅ Found ${sortedMessages.length} messages (hasMore: ${hasMore})`)

      return {
        results: sortedMessages,
        hasMore
      }
    } catch (error) {
      debug.error('❌ Failed to search messages:', error)
      throw error
    }
  }

  /**
   * Load full message objects by IDs
   */
  private async loadMessagesByIds(messageIds: string[]): Promise<Message[]> {
    if (messageIds.length === 0) {
      return []
    }

    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .in('id', messageIds)
        .or('is_deleted.is.null,is_deleted.eq.false')

      if (error) {
        debug.error('❌ Failed to load messages:', error)
        throw error
      }

      // Transform database format to Message type
      const messages: Message[] = (data || []).map(msg => ({
        id: msg.id,
        created_at: new Date(msg.created_at),
        updated_at: msg.updated_at ? new Date(msg.updated_at) : undefined,
        channel_id: msg.channel_id,
        conversation_id: msg.conversation_id,
        user_id: msg.user_id,
        bot_id: msg.bot_id,
        content: msg.content,
        reply_to: msg.reply_to,
        is_system: msg.is_system || false,
        metadata: msg.metadata,
        reactions: [],
        // 🔐 Include encryption fields for decryption
        encrypted: msg.encrypted || false,
        encryption_metadata: msg.encryption_metadata || undefined
      }))

      // 🔐 Decrypt encrypted messages
      if (messages.some(m => m.encrypted || m.encryption_metadata)) {
        debug.log('🔐 Search results contain encrypted messages, attempting decryption...')
        try {
          const { processMessageDecryption } = await import('@/utils/messageDecryption')
          const decryptedMessages = await processMessageDecryption(messages)
          debug.log('🔓 Search result decryption complete')
          return decryptedMessages
        } catch (decryptError) {
          debug.warn('⚠️ Failed to decrypt search results:', decryptError)
          // Return messages as-is if decryption fails
          return messages
        }
      }

      return messages
    } catch (error) {
      debug.error('❌ Failed to load messages by IDs:', error)
      throw error
    }
  }

  /**
   * Reindex existing messages (for migration/backfill)
   */
  async reindexMessages(
    options: {
      batchSize?: number
      signal?: AbortSignal
      onProgress?: (processed: number, total: number) => void
    } = {}
  ): Promise<void> {
    const { batchSize = 100, signal, onProgress } = options

    try {
      debug.log('🔄 Starting message reindexing...')

      // Get total count
      const { count, error: countError } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .or('is_deleted.is.null,is_deleted.eq.false')

      if (countError) {
        throw new Error(`Failed to get message count: ${countError.message}`)
      }

      const total = count || 0
      debug.log(`📊 Found ${total} messages to index`)

      let processed = 0
      let offset = 0

      while (offset < total) {
        if (signal?.aborted) {
          throw new Error('Reindexing was aborted')
        }

        // Fetch batch of messages
        const { data: messages, error } = await supabase
          .from('messages')
          .select('id, content, channel_id, conversation_id, user_id, created_at, is_deleted')
          .or('is_deleted.is.null,is_deleted.eq.false')
          .range(offset, offset + batchSize - 1)
          .order('created_at', { ascending: true })

        if (error) {
          throw new Error(`Failed to fetch messages: ${error.message}`)
        }

        if (!messages || messages.length === 0) {
          break
        }

        // Trigger reindexing by updating each message (triggers will handle indexing)
        // We'll use a simple UPDATE to trigger the index_message function
        for (const msg of messages) {
          if (signal?.aborted) {
            throw new Error('Reindexing was aborted')
          }

          // Update message to trigger indexing (using a no-op update)
          await supabase
            .from('messages')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', msg.id)

          processed++
          if (onProgress) {
            onProgress(processed, total)
          }
        }

        offset += batchSize
        debug.log(`✅ Processed ${processed}/${total} messages`)
      }

      debug.log(`✅ Reindexing complete: ${processed} messages indexed`)
    } catch (error) {
      debug.error('❌ Failed to reindex messages:', error)
      throw error
    }
  }
}

export const searchService = SearchService.getInstance()

