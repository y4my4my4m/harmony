import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import type { Thread, ThreadMember, Message } from '@/types'

// =============================================
// Thread Types
// =============================================

export interface CreateThreadParams {
  message_id: string
  name: string
  auto_archive_duration?: 60 | 1440 | 4320 | 10080 // minutes
}

export interface UpdateThreadParams {
  name?: string
  archived?: boolean
  locked?: boolean
  auto_archive_duration?: 60 | 1440 | 4320 | 10080
}

export interface ThreadWithDetails extends Thread {
  channel_name?: string
  server_id?: string
  creator_username?: string
  creator_display_name?: string
  creator_avatar_url?: string
  recent_message_count?: number
  parent_message?: Message
  is_member?: boolean
  muted?: boolean
  unread_count?: number
  last_message_preview?: string
  participants?: Array<{ id: string; display_name?: string }>
}

export interface ThreadMessagesResult {
  messages: Message[]
  has_more: boolean
  oldest_id?: string
}

// =============================================
// Thread Service Class
// =============================================

class ThreadService {
  private threadCache = new Map<string, ThreadWithDetails>()
  private memberCache = new Map<string, ThreadMember[]>()

  // =============================================
  // Thread CRUD Operations
  // =============================================

  /**
   * Create a new thread from a message
   */
  async createThread(params: CreateThreadParams): Promise<Thread | null> {
    try {
      const { data, error } = await supabase.rpc('create_thread', {
        p_message_id: params.message_id,
        p_name: params.name,
        p_auto_archive_duration: params.auto_archive_duration || 1440,
      })

      if (error) {
        debug.error('Failed to create thread:', error)
        return null
      }

      // Fetch the created thread
      const thread = await this.getThread(data)
      return thread
    } catch (error) {
      debug.error('Error creating thread:', error)
      return null
    }
  }

  /**
   * Get a single thread by ID
   */
  async getThread(threadId: string, forceRefresh = false): Promise<ThreadWithDetails | null> {
    if (!forceRefresh && this.threadCache.has(threadId)) {
      return this.threadCache.get(threadId)!
    }

    try {
      const { data, error } = await supabase
        .from('threads')
        .select(`
          *,
          channels!threads_channel_id_fkey (
            name,
            server_id
          ),
          profiles!threads_created_by_fkey (
            username,
            display_name,
            avatar_url
          ),
          parent_message:messages!threads_parent_message_id_fkey (
            id,
            content,
            user_id,
            created_at
          )
        `)
        .eq('id', threadId)
        .single()

      if (error) throw error

      // Check if current user is a member
      const { data: { user } } = await supabase.auth.getUser()
      let isMember = false
      
      if (user) {
        const { data: membership } = await supabase
          .from('thread_members')
          .select('id')
          .eq('thread_id', threadId)
          .eq('user_id', user.id)
          .single()
        
        isMember = !!membership
      }

      const thread: ThreadWithDetails = {
        ...data,
        channel_name: data.channels?.name,
        server_id: data.channels?.server_id,
        creator_username: data.profiles?.username,
        creator_display_name: data.profiles?.display_name,
        creator_avatar_url: data.profiles?.avatar_url,
        parent_message: data.parent_message,
        is_member: isMember,
      }

      this.threadCache.set(threadId, thread)
      return thread
    } catch (error) {
      debug.error('Failed to fetch thread:', error)
      return null
    }
  }

  /**
   * Get threads for a channel
   */
  async getChannelThreads(
    channelId: string,
    options: {
      includeArchived?: boolean
      limit?: number
      offset?: number
    } = {}
  ): Promise<ThreadWithDetails[]> {
    const { includeArchived = false, limit = 50, offset = 0 } = options

    try {
      let query = supabase
        .from('threads')
        .select(`
          *,
          channels!threads_channel_id_fkey (
            name,
            server_id
          ),
          profiles!threads_created_by_fkey (
            username,
            display_name,
            avatar_url
          )
        `)
        .eq('channel_id', channelId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1)

      if (!includeArchived) {
        query = query.eq('archived', false)
      }

      const { data, error } = await query

      if (error) throw error

      return (data || []).map(t => ({
        ...t,
        channel_name: t.channels?.name,
        server_id: t.channels?.server_id,
        creator_username: t.profiles?.username,
        creator_display_name: t.profiles?.display_name,
        creator_avatar_url: t.profiles?.avatar_url,
      }))
    } catch (error) {
      debug.error('Failed to fetch channel threads:', error)
      return []
    }
  }

  /**
   * Alias for getChannelThreads for component compatibility
   */
  async getThreadsForChannel(channelId: string): Promise<ThreadWithDetails[]> {
    return this.getChannelThreads(channelId)
  }

  /**
   * Get threads the current user is a member of
   */
  async getUserThreads(serverId?: string): Promise<ThreadWithDetails[]> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return []

      const { data, error } = await supabase
        .from('thread_members')
        .select(`
          thread:threads (
            *,
            channels!threads_channel_id_fkey (
              name,
              server_id
            ),
            profiles!threads_created_by_fkey (
              username,
              display_name,
              avatar_url
            )
          )
        `)
        .eq('user_id', user.id)

      if (error) throw error

      let threads: ThreadWithDetails[] = (data || [])
        .map((tm: any) => tm.thread)
        .filter((t: any): t is NonNullable<typeof t> => t !== null)
        .map((t: any) => ({
          ...t,
          channel_name: t.channels?.name,
          server_id: t.channels?.server_id,
          creator_username: t.profiles?.username,
          creator_display_name: t.profiles?.display_name,
          creator_avatar_url: t.profiles?.avatar_url,
          is_member: true,
        }))

      // Filter by server if specified
      if (serverId) {
        threads = threads.filter(t => t.server_id === serverId)
      }

      // Sort by last message
      threads.sort((a, b) => {
        const aTime = a.last_message_at ? new Date(a.last_message_at as any).getTime() : 0
        const bTime = b.last_message_at ? new Date(b.last_message_at as any).getTime() : 0
        return bTime - aTime
      })

      return threads
    } catch (error) {
      debug.error('Failed to fetch user threads:', error)
      return []
    }
  }

  /**
   * Update a thread
   */
  async updateThread(threadId: string, params: UpdateThreadParams): Promise<Thread | null> {
    try {
      const updateData: any = { ...params }
      
      // If archiving, set archived_at
      if (params.archived === true) {
        updateData.archived_at = new Date().toISOString()
      } else if (params.archived === false) {
        updateData.archived_at = null
      }

      const { data, error } = await supabase
        .from('threads')
        .update(updateData)
        .eq('id', threadId)
        .select()
        .single()

      if (error) throw error

      // Invalidate cache
      this.threadCache.delete(threadId)

      return data as Thread
    } catch (error) {
      debug.error('Failed to update thread:', error)
      return null
    }
  }

  /**
   * Delete a thread (requires MANAGE_CHANNELS permission)
   */
  async deleteThread(threadId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('threads')
        .delete()
        .eq('id', threadId)

      if (error) throw error

      this.threadCache.delete(threadId)
      this.memberCache.delete(threadId)

      return true
    } catch (error) {
      debug.error('Failed to delete thread:', error)
      return false
    }
  }

  /**
   * Archive a thread
   */
  async archiveThread(threadId: string): Promise<boolean> {
    const result = await this.updateThread(threadId, { archived: true })
    return result !== null
  }

  /**
   * Unarchive a thread
   */
  async unarchiveThread(threadId: string): Promise<boolean> {
    const result = await this.updateThread(threadId, { archived: false })
    return result !== null
  }

  /**
   * Lock a thread (prevent unarchiving by non-moderators)
   */
  async lockThread(threadId: string): Promise<boolean> {
    const result = await this.updateThread(threadId, { locked: true, archived: true })
    return result !== null
  }

  /**
   * Unlock a thread
   */
  async unlockThread(threadId: string): Promise<boolean> {
    const result = await this.updateThread(threadId, { locked: false })
    return result !== null
  }

  // =============================================
  // Thread Membership
  // =============================================

  /**
   * Join a thread
   */
  async joinThread(threadId: string): Promise<boolean> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return false

      const { error } = await supabase
        .from('thread_members')
        .upsert({
          thread_id: threadId,
          user_id: user.id,
        }, {
          onConflict: 'thread_id,user_id',
        })

      if (error) throw error

      this.memberCache.delete(threadId)
      return true
    } catch (error) {
      debug.error('Failed to join thread:', error)
      return false
    }
  }

  /**
   * Leave a thread
   */
  async leaveThread(threadId: string): Promise<boolean> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return false

      const { error } = await supabase
        .from('thread_members')
        .delete()
        .eq('thread_id', threadId)
        .eq('user_id', user.id)

      if (error) throw error

      this.memberCache.delete(threadId)
      return true
    } catch (error) {
      debug.error('Failed to leave thread:', error)
      return false
    }
  }

  /**
   * Get thread members
   */
  async getThreadMembers(threadId: string): Promise<ThreadMember[]> {
    if (this.memberCache.has(threadId)) {
      return this.memberCache.get(threadId)!
    }

    try {
      const { data, error } = await supabase
        .from('thread_members')
        .select(`
          *,
          profiles:user_id (
            id,
            username,
            display_name,
            avatar_url
          )
        `)
        .eq('thread_id', threadId)

      if (error) throw error

      const members = (data || []) as ThreadMember[]
      this.memberCache.set(threadId, members)
      return members
    } catch (error) {
      debug.error('Failed to fetch thread members:', error)
      return []
    }
  }

  /**
   * Update read position in thread
   */
  async markThreadAsRead(threadId: string, lastMessageId: string): Promise<boolean> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return false

      const { error } = await supabase
        .from('thread_members')
        .update({
          last_read_message_id: lastMessageId,
          last_read_at: new Date().toISOString(),
        })
        .eq('thread_id', threadId)
        .eq('user_id', user.id)

      if (error) throw error

      this.memberCache.delete(threadId)
      return true
    } catch (error) {
      debug.error('Failed to mark thread as read:', error)
      return false
    }
  }

  /**
   * Mute/unmute thread notifications
   */
  async setThreadMuted(threadId: string, muted: boolean): Promise<boolean> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return false

      const { error } = await supabase
        .from('thread_members')
        .update({ muted })
        .eq('thread_id', threadId)
        .eq('user_id', user.id)

      if (error) throw error

      this.memberCache.delete(threadId)
      return true
    } catch (error) {
      debug.error('Failed to update thread mute status:', error)
      return false
    }
  }

  // =============================================
  // Thread Messages
  // =============================================

  /**
   * Get messages in a thread
   */
  async getThreadMessages(
    threadId: string,
    options: {
      limit?: number
      before?: string
      after?: string
    } = {}
  ): Promise<ThreadMessagesResult> {
    const { limit = 50, before, after } = options

    try {
      let query = supabase
        .from('messages')
        .select(`
          *,
          user:profiles!messages_user_id_fkey (
            id,
            username,
            display_name,
            avatar_url,
            color
          ),
          reactions:message_reactions (
            id,
            emoji_id,
            user_id,
            emojis (
              id,
              name,
              url
            )
          )
        `)
        .eq('thread_id', threadId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(limit + 1)

      if (before) {
        query = query.lt('created_at', before)
      }
      if (after) {
        query = query.gt('created_at', after)
      }

      const { data, error } = await query

      if (error) throw error

      const messages = data || []
      const hasMore = messages.length > limit

      return {
        messages: messages.slice(0, limit).reverse() as Message[],
        has_more: hasMore,
        oldest_id: messages.length > 0 ? messages[messages.length - 1].id : undefined,
      }
    } catch (error) {
      debug.error('Failed to fetch thread messages:', error)
      return { messages: [], has_more: false }
    }
  }

  /**
   * Send a message to a thread
   */
  async sendThreadMessage(
    threadId: string,
    content: any[]
  ): Promise<Message | null> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return null

      // Get channel_id from thread
      const thread = await this.getThread(threadId)
      if (!thread) return null

      const { data, error } = await supabase
        .from('messages')
        .insert({
          thread_id: threadId,
          channel_id: thread.channel_id,
          user_id: user.id,
          content,
        })
        .select()
        .single()

      if (error) throw error

      // Invalidate thread cache to refresh stats
      this.threadCache.delete(threadId)

      return data as Message
    } catch (error) {
      debug.error('Failed to send thread message:', error)
      return null
    }
  }

  // =============================================
  // Utility Methods
  // =============================================

  /**
   * Get thread for a message (if exists)
   */
  async getThreadForMessage(messageId: string): Promise<ThreadWithDetails | null> {
    try {
      const { data, error } = await supabase
        .from('threads')
        .select('id')
        .eq('parent_message_id', messageId)
        .single()

      if (error || !data) return null

      return this.getThread(data.id)
    } catch (error) {
      return null
    }
  }

  /**
   * Check if a message has a thread
   */
  async messageHasThread(messageId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('threads')
        .select('id')
        .eq('parent_message_id', messageId)
        .single()

      return !error && !!data
    } catch {
      return false
    }
  }

  /**
   * Get unread count for a thread
   */
  async getUnreadCount(threadId: string): Promise<number> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return 0

      // Get last read position
      const { data: membership } = await supabase
        .from('thread_members')
        .select('last_read_at')
        .eq('thread_id', threadId)
        .eq('user_id', user.id)
        .single()

      if (!membership?.last_read_at) {
        // Never read, return total message count
        const thread = await this.getThread(threadId)
        return thread?.message_count || 0
      }

      // Count messages after last read
      const { count, error } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('thread_id', threadId)
        .eq('is_deleted', false)
        .gt('created_at', membership.last_read_at)

      if (error) return 0
      return count || 0
    } catch (error) {
      debug.error('Failed to get unread count:', error)
      return 0
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.threadCache.clear()
    this.memberCache.clear()
  }

  /**
   * Clear cache for specific thread
   */
  clearThreadCache(threadId: string): void {
    this.threadCache.delete(threadId)
    this.memberCache.delete(threadId)
  }
}

// Export singleton instance
export const threadService = new ThreadService()

