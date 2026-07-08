import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import type { Thread, ThreadMember, Message } from '@/types'
import { authContextService } from '@/services/AuthContextService'
import { ensureMessageEmbeds } from '@/utils/messageEmbedUtils'
import {
  DEFAULT_MAX_MESSAGE_TEXT_LENGTH,
  MESSAGE_TEXT_HARD_CEILING,
  messageTextLength,
} from '@/utils/messageContentUtils'

// Thread Types

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

// Thread Service Class

interface ThreadMessageCache {
  messages: Message[]
  lastFetchedAt: Date
  oldestMessageId?: string
  hasMore: boolean
}

class ThreadService {
  private threadCache = new Map<string, ThreadWithDetails>()
  private memberCache = new Map<string, ThreadMember[]>()
  
  // Professional message caching system (same pattern as useChat/useDM)
  private messageCache = new Map<string, ThreadMessageCache>()
  private cacheValidityDuration = 5 * 60 * 1000 // 5 minutes
  private maxCacheSize = 50 // Maximum number of threads to cache

  /**
   * Check if thread messages are cached and fresh (without fetching)
   * Used by UI to decide if loading indicator should be shown
   */
  hasValidMessageCache(threadId: string): boolean {
    const cached = this.messageCache.get(threadId)
    if (!cached) return false
    
    const cacheAge = Date.now() - cached.lastFetchedAt.getTime()
    return cacheAge < this.cacheValidityDuration
  }

  /**
   * Get cached messages instantly (returns null if not cached/stale)
   * For optimistic UI rendering
   */
  getCachedMessages(threadId: string): ThreadMessagesResult | null {
    const cached = this.messageCache.get(threadId)
    if (!cached) return null
    
    const cacheAge = Date.now() - cached.lastFetchedAt.getTime()
    if (cacheAge >= this.cacheValidityDuration) return null
    
    return {
      messages: [...cached.messages],
      has_more: cached.hasMore,
      oldest_id: cached.oldestMessageId,
    }
  }

  // Thread CRUD Operations

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
      // Simple query without FK hints - fetch thread data directly
      const { data, error } = await supabase
        .from('threads')
        .select('*')
        .eq('id', threadId)
        .single()

      if (error) throw error

      let channelData = null
      let creatorData = null
      let parentMessage = null

      if (data.channel_id) {
        const { data: channel } = await supabase
          .from('channels')
          .select('name, server_id')
          .eq('id', data.channel_id)
          .single()
        channelData = channel
      }

      if (data.created_by) {
        const { data: creator } = await supabase
          .from('profiles')
          .select('username, display_name, avatar_url')
          .eq('id', data.created_by)
          .single()
        creatorData = creator
      }

      if (data.parent_message_id) {
        const { data: msg } = await supabase
          .from('messages')
          .select('id, content, user_id, created_at')
          .eq('id', data.parent_message_id)
          .single()
        parentMessage = msg
      }

      let isMember = false
      try {
        const profileId = await authContextService.getCurrentProfileId()
        const { data: membership } = await supabase
          .from('thread_members')
          .select('id')
          .eq('thread_id', threadId)
          .eq('user_id', profileId)
          .maybeSingle()
        
        isMember = !!membership
      } catch {
        // User not authenticated or profile not found
        isMember = false
      }

      const thread: ThreadWithDetails = {
        ...data,
        channel_name: channelData?.name,
        server_id: channelData?.server_id,
        creator_username: creatorData?.username,
        creator_display_name: creatorData?.display_name,
        creator_avatar_url: creatorData?.avatar_url,
        parent_message: parentMessage,
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
      // Simple query without FK hints
      let query = supabase
        .from('threads')
        .select('*')
        .eq('channel_id', channelId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .range(offset, offset + limit - 1)

      if (!includeArchived) {
        query = query.eq('archived', false)
      }

      const { data, error } = await query

      if (error) throw error

      return (data || []).map((t: any) => ({
        ...t,
        channel_name: undefined, // Will be fetched if needed
        server_id: undefined,
        creator_username: undefined,
        creator_display_name: undefined,
        creator_avatar_url: undefined,
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
   * Get all threads for a server (across all channels)
   */
  async getServerThreads(
    serverId: string,
    options: {
      archived?: boolean
      limit?: number
    } = {}
  ): Promise<ThreadWithDetails[]> {
    const { archived = false, limit = 20 } = options

    try {
      // First get all channels for this server
      const { data: channels, error: channelsError } = await supabase
        .from('channels')
        .select('id, name')
        .eq('server_id', serverId)

      if (channelsError) throw channelsError
      if (!channels || channels.length === 0) return []

      const channelIds = channels.map(c => c.id)
      const channelMap = new Map(channels.map(c => [c.id, c.name]))

      let query = supabase
        .from('threads')
        .select('*')
        .in('channel_id', channelIds)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(limit)

      if (!archived) {
        query = query.eq('archived', false)
      }

      const { data, error } = await query

      if (error) throw error

      return (data || []).map((t: any) => ({
        ...t,
        channel_name: channelMap.get(t.channel_id),
        server_id: serverId,
      }))
    } catch (error) {
      debug.error('Failed to fetch server threads:', error)
      return []
    }
  }

  /**
   * Get threads the current user is a member of
   */
  async getUserThreads(serverId?: string): Promise<ThreadWithDetails[]> {
    try {
      const profileId = await authContextService.getCurrentProfileId()

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
        .eq('user_id', profileId)

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

      if (serverId) {
        threads = threads.filter(t => t.server_id === serverId)
      }

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
        .maybeSingle()

      if (error) throw error

      if (!data) {
        debug.error('Thread update returned no data - insufficient permissions or thread not found')
        return null
      }

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

  // Thread Membership

  /**
   * Join a thread
   */
  async joinThread(threadId: string): Promise<boolean> {
    try {
      const profileId = await authContextService.getCurrentProfileId()

      const { error } = await supabase
        .from('thread_members')
        .upsert({
          thread_id: threadId,
          user_id: profileId,
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
      const profileId = await authContextService.getCurrentProfileId()

      const { error } = await supabase
        .from('thread_members')
        .delete()
        .eq('thread_id', threadId)
        .eq('user_id', profileId)

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
      const profileId = await authContextService.getCurrentProfileId()

      const { error } = await supabase
        .from('thread_members')
        .update({
          last_read_message_id: lastMessageId,
          last_read_at: new Date().toISOString(),
        })
        .eq('thread_id', threadId)
        .eq('user_id', profileId)

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
      const profileId = await authContextService.getCurrentProfileId()

      const { error } = await supabase
        .from('thread_members')
        .update({ muted })
        .eq('thread_id', threadId)
        .eq('user_id', profileId)

      if (error) throw error

      this.memberCache.delete(threadId)
      return true
    } catch (error) {
      debug.error('Failed to update thread mute status:', error)
      return false
    }
  }

  // Thread Messages

  /**
   * Check if thread messages are cached and valid
   */
  private isCacheValid(threadId: string): boolean {
    if (!this.messageCache.has(threadId)) return false
    
    const cached = this.messageCache.get(threadId)!
    const now = new Date()
    const cacheAge = now.getTime() - cached.lastFetchedAt.getTime()
    
    return cacheAge < this.cacheValidityDuration
  }

  /**
   * Load messages from cache (instant loading)
   */
  private loadCachedMessages(threadId: string): ThreadMessagesResult | null {
    const cached = this.messageCache.get(threadId)
    if (cached && this.isCacheValid(threadId)) {
      debug.log(`Loading ${cached.messages.length} thread messages from cache: ${threadId}`)
      return {
        messages: [...cached.messages],
        has_more: cached.hasMore,
        oldest_id: cached.oldestMessageId,
      }
    }
    return null
  }

  /**
   * Evict oldest cache entries when limit is reached
   */
  private evictOldestCache(): void {
    if (this.messageCache.size <= this.maxCacheSize) return

    let oldestThreadId: string | null = null
    let oldestTime = new Date()

    this.messageCache.forEach((cache, threadId) => {
      if (cache.lastFetchedAt < oldestTime) {
        oldestTime = cache.lastFetchedAt
        oldestThreadId = threadId
      }
    })

    if (oldestThreadId) {
      this.messageCache.delete(oldestThreadId)
      debug.log(`Evicted thread message cache: ${oldestThreadId}`)
    }
  }

  /**
   * Add message to cache (for realtime updates)
   */
  addMessageToCache(threadId: string, message: Message): void {
    const cached = this.messageCache.get(threadId)
    if (cached) {
      if (!cached.messages.some(msg => msg.id === message.id)) {
        cached.messages.push(message)
        debug.log(`Added message to thread cache: ${message.id}`)
      }
    } else {
      this.evictOldestCache()
      this.messageCache.set(threadId, {
        messages: [message],
        lastFetchedAt: new Date(),
        hasMore: false,
      })
    }
  }

  /**
   * Update message in cache (for edits)
   */
  updateMessageInCache(threadId: string, messageId: string, updatedMessage: Message): void {
    const cached = this.messageCache.get(threadId)
    if (cached) {
      const index = cached.messages.findIndex(msg => msg.id === messageId)
      if (index !== -1) {
        cached.messages[index] = updatedMessage
        debug.log(`Updated message in thread cache: ${messageId}`)
      }
    }
  }

  /**
   * Remove message from cache (for deletes)
   */
  removeMessageFromCache(threadId: string, messageId: string): void {
    const cached = this.messageCache.get(threadId)
    if (cached) {
      cached.messages = cached.messages.filter(msg => msg.id !== messageId)
      debug.log(`Removed message from thread cache: ${messageId}`)
    }
  }


  /**
   * Get messages in a thread (with intelligent caching)
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

    // For initial load (no pagination), check cache first
    if (!before && !after) {
      const cached = this.messageCache.get(threadId)
      if (cached) {
        const cacheAge = Date.now() - cached.lastFetchedAt.getTime()
        
        // If cache is fresh (less than 5 minutes old), return instantly
        if (cacheAge < this.cacheValidityDuration) {
          debug.log(`Loading ${cached.messages.length} thread messages from cache instantly (age: ${Math.round(cacheAge / 1000)}s)`)
          return {
            messages: [...cached.messages],
            has_more: cached.hasMore,
            oldest_id: cached.oldestMessageId,
          }
        } else {
          debug.log(`Thread cache is stale (${Math.round(cacheAge / 1000)}s old), fetching from database`)
        }
      } else {
        debug.log(`No cache found for thread ${threadId}, fetching from database`)
      }
    }

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
          reactions:reactions (
            id,
            emoji_id,
            user_id,
            emojis!reactions_emoji_id_fkey (
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
      const resultMessages = messages.slice(0, limit).reverse() as Message[]
      
      try {
        ensureMessageEmbeds(resultMessages)
      } catch (error) {
        debug.warn('Failed to prepare thread message embeds:', error)
      }

      const result: ThreadMessagesResult = {
        messages: resultMessages,
        has_more: hasMore,
        oldest_id: messages.length > 0 ? messages[messages.length - 1].id : undefined,
      }

      if (!before && !after) {
        this.evictOldestCache()
        this.messageCache.set(threadId, {
          messages: [...resultMessages],
          lastFetchedAt: new Date(),
          oldestMessageId: result.oldest_id,
          hasMore: hasMore,
        })
        debug.log(`Cached ${resultMessages.length} thread messages: ${threadId}`)
      } else if (before) {
        // Loading older messages - prepend to cache
        const cached = this.messageCache.get(threadId)
        if (cached) {
          cached.messages = [...resultMessages, ...cached.messages]
          cached.oldestMessageId = result.oldest_id
          cached.hasMore = hasMore
          debug.log(`Updated cache with ${resultMessages.length} older messages: ${threadId}`)
        }
      }

      return result
    } catch (error) {
      debug.error('Failed to fetch thread messages:', error)
      return { messages: [], has_more: false }
    }
  }

  /**
   * Fetch max media attachments limit from instance config (default 20)
   */
  private async getMaxMediaAttachments(): Promise<number> {
    const { data } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'max_media_attachments_per_post')
      .maybeSingle()
    const v = data?.config_value
    if (typeof v === 'number' && v >= 1) return v
    const parsed = typeof v === 'string' ? parseInt(String(v), 10) : NaN
    return !isNaN(parsed) && parsed >= 1 ? parsed : 20
  }

  /**
   * Fetch the admin-configured max message length from `instance_config`.
   * Same semantics as `CoreMessageService.getMaxMessageLength` (clamped to
   * the DB-side hard ceiling so a misconfigured admin value can't push a
   * row into a state the CHECK constraint will reject).
   */
  private async getMaxMessageLength(): Promise<number> {
    const { data } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'max_message_length')
      .maybeSingle()
    const raw = data?.config_value
    const parsed =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? parseInt(raw, 10)
          : NaN
    const value = !Number.isNaN(parsed) && parsed >= 1
      ? parsed
      : DEFAULT_MAX_MESSAGE_TEXT_LENGTH
    return Math.min(value, MESSAGE_TEXT_HARD_CEILING)
  }

  /**
   * Send a message to a thread.
   *
   * Threads live inside a channel, so the channel's server encryption policy
   * applies. We reject thread sends in encryption-eligible channels unless
   * encryption succeeds, mirroring CoreMessageService.sendChannelMessage's
   * fail-closed policy. Pass `options.allowPlaintextFallback = true` for an
   * explicit, user-confirmed plaintext send.
   *
   * NOTE: Throwing here is intentional. Callers that previously consumed
   * `null` should treat `null` as "could not load thread" and propagate
   * encryption errors so the UI can prompt for fallback consent.
   */
  async sendThreadMessage(
    threadId: string,
    content: any[],
    replyTo?: string,
    extraMetadata?: Record<string, any>,
    options?: { allowPlaintextFallback?: boolean }
  ): Promise<Message | null> {
    // Enforce max message length BEFORE encryption / DB roundtrip so the
    // error surfaces cleanly. The limit is admin-configurable via
    // `instance_config.max_message_length`; fall back to the default and
    // clamp at the DB-side hard ceiling.
    const maxLength = await this.getMaxMessageLength()
    const textLen = messageTextLength(content as any)
    if (textLen > maxLength) {
      const err: any = new Error(
        `Message is too long (${textLen.toLocaleString()} / ${maxLength.toLocaleString()} characters).`,
      )
      err.code = 'MESSAGE_TOO_LONG'
      throw err
    }

    // Enforce max media attachments per message (instance config, default 20)
    const fileParts = content.filter((p: any) => p?.type === 'file')
    const maxMedia = await this.getMaxMediaAttachments()
    if (fileParts.length > maxMedia) {
      throw new Error(`Maximum ${maxMedia} media attachments per message`)
    }

    const profileId = await authContextService.getCurrentProfileId()

    // Get channel_id from thread (cannot proceed without it)
    const thread = await this.getThread(threadId)
    if (!thread) return null

    // Apply channel-level encryption policy. Look up the server for this
    // channel, then defer to the same fail-closed flow used by chat sends.
    let serverId: string | null = null
    try {
      const { data: channelRow } = await supabase
        .from('channels')
        .select('server_id')
        .eq('id', thread.channel_id)
        .maybeSingle()
      serverId = (channelRow as any)?.server_id ?? null
    } catch (lookupError) {
      debug.warn('Failed to resolve server for thread channel:', lookupError)
    }

    let finalContent: any[] = content
    let encrypted = false
    let encryptionMetadata: any = null
    const extra: Record<string, any> = { ...(extraMetadata || {}) }
    const allowFallback = options?.allowPlaintextFallback === true

    let encryptionMode: 'disabled' | 'optional' | 'required' = 'disabled'
    if (serverId) {
      try {
        const { data: settings } = await supabase
          .from('server_encryption_settings')
          .select('encryption_mode')
          .eq('server_id', serverId)
          .maybeSingle()
        encryptionMode = ((settings as any)?.encryption_mode as any) || 'disabled'
      } catch (lookupError) {
        debug.warn('Failed to resolve server encryption settings:', lookupError)
      }
    }

    if (encryptionMode !== 'disabled') {
      let encryptionService: any = null
      try {
        const mod = await import('@/services/encryption/MegolmMessageEncryptionService')
        encryptionService = mod.megolmMessageEncryptionService
      } catch (loadErr) {
        debug.warn('Encryption service unavailable for thread send:', loadErr)
      }

      const hasService = !!encryptionService && encryptionService.isInitialized()
      const hasRecoveryKey = hasService ? await encryptionService.hasRecoveryKey() : false
      const isUnlocked = hasService ? encryptionService.isUnlocked() : false

      if (hasService && hasRecoveryKey && isUnlocked) {
        try {
          let recipientIds: string[] = []
          if (serverId) {
            const { data: members } = await supabase
              .from('user_servers')
              .select('user_id')
              .eq('server_id', serverId)
            recipientIds = members?.map(m => m.user_id) || []
          }
          if (!recipientIds.includes(profileId)) recipientIds.push(profileId)

          const encryptedData = await encryptionService.encryptMessage(content, thread.channel_id, recipientIds)
          finalContent = encryptedData.content
          encrypted = true
          encryptionMetadata = encryptedData.encryption_metadata
        } catch (encryptError) {
          debug.error('Thread encryption failed:', encryptError)
          if (encryptionMode === 'required') {
            const err: any = new Error('Server requires encryption but encryption failed')
            err.code = 'ENCRYPTION_REQUIRED'
            throw err
          }
          if (!allowFallback) {
            const err: any = new Error('Thread encryption failed and plaintext fallback was not authorized')
            err.code = 'ENCRYPTION_FAILED_NO_FALLBACK'
            throw err
          }
          extra.plaintext_override = { authorized: true, reason: 'thread_encrypt_failed', at: new Date().toISOString() }
        }
      } else if (encryptionMode === 'required') {
        if (!hasRecoveryKey) {
          const err: any = new Error('This server requires encryption. Set up encryption in Settings first.')
          err.code = 'ENCRYPTION_REQUIRED'
          throw err
        }
        const err: any = new Error('This server requires encryption. Unlock encryption with your recovery key first.')
        err.code = 'ENCRYPTION_LOCKED'
        throw err
      } else {
        // Optional + unable to encrypt. Mirrors `CoreMessageService`:
        //   - keys locked  → fail closed (prompt the user, they opted in)
        //   - no keys      → silent plaintext (user never opted in)
        if (hasRecoveryKey && !isUnlocked) {
          if (!allowFallback) {
            const err: any = new Error('This thread supports encryption but your keys are locked.')
            err.code = 'ENCRYPTION_LOCKED'
            throw err
          }
          extra.plaintext_override = {
            authorized: true,
            reason: 'thread_encryption_locked',
            at: new Date().toISOString(),
          }
        } else {
          // No recovery key - silent plaintext, no prompt.
          extra.plaintext_override = {
            authorized: true,
            reason: 'thread_no_recovery_key',
            at: new Date().toISOString(),
          }
        }
      }
    }

    const insertData: any = {
      thread_id: threadId,
      channel_id: thread.channel_id,
      user_id: profileId,
      content: finalContent,
      encrypted,
      encryption_metadata: encryptionMetadata,
    }

    if (replyTo) insertData.reply_to = replyTo
    insertData.metadata = { created_via: 'harmony_client', ...extra }

    const { data, error } = await supabase
      .from('messages')
      .insert(insertData)
      .select()
      .single()

    if (error) throw error

    // Invalidate thread cache to refresh stats
    this.threadCache.delete(threadId)

    const message = data as Message

    try {
      ensureMessageEmbeds(message)
    } catch (embedError) {
      debug.warn('Failed to prepare embeds for sent thread message:', embedError)
    }

    return message
  }

  // Utility Methods

  /**
   * Get thread for a message (if exists)
   */
  async getThreadForMessage(messageId: string): Promise<ThreadWithDetails | null> {
    try {
      const { data, error } = await supabase
        .from('threads')
        .select('id')
        .eq('parent_message_id', messageId)
        .maybeSingle()

      if (error) {
        debug.warn('Error checking for thread:', error)
        return null
      }
      
      if (!data) return null

      return this.getThread(data.id)
    } catch (error) {
      debug.warn('Exception checking for thread:', error)
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
      const profileId = await authContextService.getCurrentProfileId()

      const { data: membership } = await supabase
        .from('thread_members')
        .select('last_read_at')
        .eq('thread_id', threadId)
        .eq('user_id', profileId)
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
   * Clear cache for specific thread (clears thread, member, and message caches)
   */
  clearThreadCache(threadId: string): void {
    this.threadCache.delete(threadId)
    this.memberCache.delete(threadId)
    this.messageCache.delete(threadId)
    debug.log(`Cleared all caches for thread: ${threadId}`)
  }
}

// Export singleton instance
export const threadService = new ThreadService()

