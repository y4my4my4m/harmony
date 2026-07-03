import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase } from '@/supabase'
import { services } from '@/services'
import type { Message, MessagePart } from '@/types'
import { useServerUsersStore } from './useServerUsers'
import { useReactionsStore } from './useReactions'
import { userDataService } from '@/services/userDataService'
import { extractMentionsFromMessageParts } from '@/utils/unifiedContentProcessing'
import { ensureMessageEmbeds } from '@/utils/messageEmbedUtils'
import { processMessageDecryption } from '@/utils/messageDecryption'
import { debug } from '@/utils/debug'
import { realtimeConnectionManager, type ConnectionStatus } from '@/services/RealtimeConnectionManager'
import { userEventChannel } from '@/services/UserEventChannel'
import { getRandomId, createTempMessageId, findOptimisticMatchIndex } from '@/stores/shared/optimisticMessages'

export interface DMUser {
  id: string
  username: string
  display_name?: string
  avatar_url?: string
  is_online?: boolean
  last_seen?: string
  domain?: string
  is_local?: boolean
  federated_id?: string
  handle?: string
  color?: string // Optional color for UI
  _isPlaceholder?: boolean
}

export interface DMConversation {
  id: string
  created_at: string
  last_activity?: string
  last_message?: Message
  unread_count?: number
  other_user?: DMUser // For direct conversations
  type?: string // 'direct' | 'group'
  participant_count?: number
  is_muted?: boolean
  
  name?: string // Group name
  icon_url?: string // Group icon
  created_by?: string // Creator user ID
  participants?: DMUser[] // All participants for group chats

  // Per-user dismissal: when set, the conversation is hidden from the list
  // unless its latest activity is newer than this timestamp.
  hidden_at?: string | null
}

/**
 * A dismissed conversation stays hidden only while its most recent activity is
 * older than `hidden_at`. Any newer message brings it back into the list.
 */
function isConversationHidden(hiddenAt: string | null | undefined, lastActivity: string | null | undefined): boolean {
  if (!hiddenAt) return false
  const lastTs = lastActivity ? new Date(lastActivity).getTime() : 0
  return lastTs <= new Date(hiddenAt).getTime()
}

export interface DMCache {
  messages: Message[]
  lastFetchedAt: Date
  oldestMessageId: string | null
  allMessagesLoaded: boolean
  lastModified: Date
}

export const useDMStore = defineStore('dm', () => {
  const conversations = ref<DMConversation[]>([])
  const currentConversationId = ref<string | null>(null)
  const currentDMMessages = ref<Message[]>([])
  const searchResults = ref<DMUser[]>([])
  
  const loadingConversations = ref(false)
  const loadingMessages = ref(false)
  const isSearching = ref(false)
  const allMessagesLoaded = ref(false)
  const isInitializing = ref(false)
  
  const messageCache = ref<Map<string, DMCache>>(new Map())
  const cacheValidityDuration = 5 * 60 * 1000 // 5 minutes
  const maxCacheSize = 50 // Maximum number of conversations to cache
  
  const dmSubscriptions = ref<Map<string, any>>(new Map())
  const currentSubscription = ref<any | null>(null)
  
  // Global broadcast handlers (persist across route changes, cleaned up only on logout)
  let _globalBroadcastUnsubs: (() => void)[] = []
  let _globalBroadcastRegistered = false
  
  const dmConnectionStatus = ref<import('@/services/RealtimeConnectionManager').ConnectionStatus>('disconnected')
  
  const replyMessageCache = ref<Map<string, Message>>(new Map())
  const fetchingReplyMessages = ref<Set<string>>(new Set())
  
  
  const pendingConversationListFetch = ref<Promise<void> | null>(null)
  
  const pendingConversationDetailsFetch = ref<Map<string, Promise<DMConversation | null>>>(new Map())
  
  const pendingMessagesFetch = ref<Map<string, Promise<void>>>(new Map())
  
  const pendingProfileFetches = ref<Map<string, Promise<any>>>(new Map())
  
  const getCurrentConversation = computed(() => {
    return conversations.value.find(c => c.id === currentConversationId.value)
  })
  
  const getSortedConversations = computed(() => {
    // BUGS.md H35: previously this called `.sort()` directly on
    // `conversations.value`, mutating Pinia store state inside a getter.
    // Side effects in computed getters break reactivity expectations:
    // any read of `getSortedConversations` would reorder the underlying
    // array, causing flicker on parallel readers, broken devtools history,
    // and incorrect ordering when other code assumes the source array is
    // stable. Sort a copy instead.
    return [...conversations.value].sort((a, b) => {
      const aTime = new Date(a.last_activity || a.created_at).getTime()
      const bTime = new Date(b.last_activity || b.created_at).getTime()
      return bTime - aTime
    })
  })

  /**
   * Total unread DM count across every conversation. Drives the unread
   * badge on the DM tab in the main navigation. Previously the badge code
   * read `(dmStore as any).getTotalUnreadCount`, but no such getter
   * existed - the cast hid `undefined > 0 === false`, so the badge never
   * appeared even when the user had unread DMs.
   */
  const getTotalUnreadCount = computed(() => {
    let total = 0
    for (const c of conversations.value) {
      total += c.unread_count || 0
    }
    return total
  })

  const isUserOnline = async (userId: string): Promise<boolean> => {
    try {
      const { userDataService } = await import('@/services/userDataService')
      const userData = userDataService.getUser(userId)
      return userData?.isOnline || false
    } catch (error) {
      debug.error('Failed to check user online status:', error)
      const user = searchResults.value.find(u => u.id === userId)
      return user?.is_online || false
    }
  }

  const evictOldestCache = () => {
    if (messageCache.value.size <= maxCacheSize) return

    let oldestTime = new Date()
    let oldestConversationId = ''

    messageCache.value.forEach((cache, conversationId) => {
      if (cache.lastFetchedAt < oldestTime) {
        oldestTime = cache.lastFetchedAt
        oldestConversationId = conversationId
      }
    })

    if (oldestConversationId) {
      messageCache.value.delete(oldestConversationId)
      debug.log(`Evicted DM cache for conversation: ${oldestConversationId}`)
    }
  }

  const isCacheValid = (conversationId: string): boolean => {
    if (!messageCache.value.has(conversationId)) return false
    
    const cached = messageCache.value.get(conversationId)!
    const now = new Date()
    const cacheAge = now.getTime() - cached.lastFetchedAt.getTime()
    
    return cacheAge < cacheValidityDuration
  }

  const loadCachedMessages = (conversationId: string) => {
    const cached = messageCache.value.get(conversationId)
    if (cached) {
      debug.log(`Loading cached DM messages instantly: ${conversationId}`)
      currentDMMessages.value = [...cached.messages]
      allMessagesLoaded.value = cached.allMessagesLoaded
    }
  }

  /**
   * Insert a message into a sorted array by created_at.
   * Fast path for newest messages (append), binary insert for older ones.
   */
  const insertMessageSorted = (arr: Message[], msg: Message) => {
    const msgTime = new Date(msg.created_at).getTime()
    if (arr.length === 0 || new Date(arr[arr.length - 1].created_at).getTime() <= msgTime) {
      arr.push(msg)
      return
    }
    let lo = 0, hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (new Date(arr[mid].created_at).getTime() <= msgTime) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    arr.splice(lo, 0, msg)
  }

  /**
   * Catch up on DM messages that arrived while this conversation wasn't the
   * active realtime subscription. Mirrors useChat.revalidateRecentMessages.
   */
  const revalidateRecentDMMessages = async (conversationId: string) => {
    try {
      const msgs = currentDMMessages.value
      const newest = msgs.length ? msgs[msgs.length - 1] : null
      if (!newest) return // empty conversation - realtime will populate it
      const ts: unknown = newest.created_at
      const afterTs = ts instanceof Date ? ts.toISOString() : (typeof ts === 'string' ? ts : undefined)
      if (!afterTs) return

      const { messages: messagesData } = await services.messages.loadConversationMessages(conversationId, {
        limit: 50,
        after: afterTs,
      })
      if (!messagesData || messagesData.length === 0) return
      // Bail if the user navigated away while we were fetching.
      if (currentConversationId.value !== conversationId) return

      const existingIds = new Set(currentDMMessages.value.map(m => m.id))
      const freshRaw = messagesData.filter(m => !existingIds.has(m.id))
      if (freshRaw.length === 0) return

      const userIds = [...new Set(freshRaw.map(m => m.user_id).filter(Boolean))] as string[]
      if (userIds.length > 0) {
        const serverUsersStore = useServerUsersStore()
        await serverUsersStore.fetchMultipleUserProfiles(userIds)
      }
      if (currentConversationId.value !== conversationId) return

      // CoreMessageService already decrypted these; preserve the flags and
      // normalize to the same shape the initial load uses.
      const fresh: Message[] = (freshRaw.map(msg => ({
        id: msg.id,
        user_id: msg.user_id,
        content: msg.content,
        created_at: new Date(msg.created_at),
        channel_id: '',
        conversation_id: conversationId,
        reply_to: msg.reply_to,
        reactions: msg.reactions || [],
        is_system: msg.is_system,
        metadata: msg.metadata || null,
        encrypted: msg.encrypted || false,
        decrypted: msg.decrypted || false,
        encryption_metadata: msg.encryption_metadata,
      })) as unknown as Message[])

      try { ensureMessageEmbeds(fresh) } catch (e) { debug.warn('Failed to prepare embeds for caught-up DM messages:', e) }

      const merged = [...currentDMMessages.value]
      for (const m of fresh) insertMessageSorted(merged, m)
      currentDMMessages.value = merged

      const cached = messageCache.value.get(conversationId)
      if (cached) {
        cached.messages = [...merged]
        cached.lastFetchedAt = new Date()
        cached.lastModified = new Date()
      }
      debug.log(`🔄 DM revalidate: merged ${fresh.length} missed message(s) for ${conversationId}`)
    } catch (error) {
      debug.warn('Revalidate recent DM messages failed (non-fatal):', error)
    }
  }

  const addMessageToCache = (message: Message) => {
    try {
      ensureMessageEmbeds(message)
    } catch (error) {
      debug.warn('Failed to prepare DM message embeds:', error)
    }
    if (currentConversationId.value === message.conversation_id) {
      if (!currentDMMessages.value.some(msg => msg.id === message.id)) {
        insertMessageSorted(currentDMMessages.value, message)
      }
    }

    const cached = messageCache.value.get(message.conversation_id!)
    if (cached) {
      if (!cached.messages.some(msg => msg.id === message.id)) {
        insertMessageSorted(cached.messages, message)
        cached.lastModified = new Date()
      }
    } else {
      messageCache.value.set(message.conversation_id!, {
        messages: [message],
        lastFetchedAt: new Date(),
        oldestMessageId: message.id,
        allMessagesLoaded: false,
        lastModified: new Date()
      })
    }

    updateConversationFromMessage(message)
  }

  const updateMessageInCache = (messageId: string, updatedMessage: Message) => {
    const currentIndex = currentDMMessages.value.findIndex(msg => msg.id === messageId)
    if (currentIndex !== -1) {
      currentDMMessages.value[currentIndex] = updatedMessage
    }

    messageCache.value.forEach((cache) => {
      const cacheIndex = cache.messages.findIndex(msg => msg.id === messageId)
      if (cacheIndex !== -1) {
        cache.messages[cacheIndex] = updatedMessage
        cache.lastModified = new Date()
      }
    })

    try {
      // `ensureMessageEmbeds` takes a single argument now; the legacy
      // `{ force: true }` flag is no longer honoured.
      ensureMessageEmbeds(updatedMessage)
    } catch (error) {
      debug.warn('Failed to refresh DM embeds for updated message:', error)
    }
  }

  const reprocessEncryptedDMMessages = async (roomId?: string) => {
    try {
      if (roomId) {
        if (currentConversationId.value === roomId && currentDMMessages.value.length > 0) {
          const hasEncrypted = currentDMMessages.value.some((m: Message) => m.encrypted && !m.decrypted)
          if (hasEncrypted) {
            currentDMMessages.value = await processMessageDecryption(currentDMMessages.value)
          }
        }
        const cache = messageCache.value.get(roomId)
        if (cache?.messages?.length) {
          const hasCacheEncrypted = cache.messages.some((m: Message) => m.encrypted && !m.decrypted)
          if (hasCacheEncrypted) {
            cache.messages = await processMessageDecryption(cache.messages)
          }
        }
        return
      }

      const hasEncrypted = currentDMMessages.value.some((m: Message) => m.encrypted && !m.decrypted)
      if (hasEncrypted) {
        currentDMMessages.value = await processMessageDecryption(currentDMMessages.value)
      }
      for (const cache of messageCache.value.values()) {
        if (cache.messages?.length) {
          const hasCacheEncrypted = cache.messages.some((m: Message) => m.encrypted && !m.decrypted)
          if (hasCacheEncrypted) {
            cache.messages = await processMessageDecryption(cache.messages)
          }
        }
      }
    } catch (error) {
      debug.warn('Failed to reprocess encrypted DM messages:', error)
    }
  }

  let _userUpdatedHandler: ((event: any) => void) | null = null
  let _userDataServiceRef: any = null
  let _keyListenerActive = false
  const setupEncryptionKeyListener = () => {
    if (_keyListenerActive) return
    _keyListenerActive = true
    window.addEventListener('megolm-key-received', async (e: Event) => {
      const detail = (e as CustomEvent).detail
      const roomId = detail?.roomId as string | undefined
      debug.log(`🔑 Key received${roomId ? ` for room ${roomId.substring(0, 8)}...` : ''} - re-decrypting DMs`)
      await reprocessEncryptedDMMessages(roomId)
    })
  }

  const removeMessageFromCache = (messageId: string) => {
    currentDMMessages.value = currentDMMessages.value.filter(msg => msg.id !== messageId)

    messageCache.value.forEach((cache) => {
      cache.messages = cache.messages.filter(msg => msg.id !== messageId)
      cache.lastModified = new Date()
    })
  }

  const editMessage = async (messageId: string, content: MessagePart[]) => {
    try {
      debug.log('🔄 Editing DM message via MessageService:', messageId)

      const currentMessage = currentDMMessages.value.find(msg => msg.id === messageId)
      if (!currentMessage) {
        debug.error('❌ DM message not found in current messages:', messageId)
        return
      }

      const updatedMessage = await services.messages.editMessage(messageId, content)

      const messageWithReactions = {
        ...updatedMessage,
        reactions: currentMessage.reactions || [],
      }

      updateMessageInCache(messageId, messageWithReactions)
      debug.log('✅ DM message edited via service layer')
    } catch (error: any) {
      debug.error('❌ Error editing DM message:', error)
      throw new Error(error.message || 'Failed to edit message')
    }
  }

  const deleteMessage = async (messageId: string) => {
    try {
      debug.log('🔄 Deleting DM message via MessageService:', messageId)
      await services.messages.deleteMessage(messageId)
      removeMessageFromCache(messageId)
      debug.log('✅ DM message deleted')
    } catch (error: any) {
      debug.error('❌ Error deleting DM message:', error)
      throw new Error(error.message || 'Failed to delete message')
    }
  }

  const highlightedMessageId = ref<string | null>(null)

  const jumpToMessage = async (messageId: string): Promise<boolean> => {
    const existingMessage = currentDMMessages.value.find(msg => msg.id === messageId)
    if (existingMessage) {
      highlightedMessageId.value = messageId
      return true
    }

    try {
      const { data: message, error } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .eq('conversation_id', currentConversationId.value)
        .single()

      if (error || !message) {
        debug.error('DM message not found for jump:', error)
        return false
      }

      const messageDate = new Date(message.created_at)
      const msgs = [...currentDMMessages.value]
      let insertIndex = 0
      for (let i = 0; i < msgs.length; i++) {
        if (new Date(msgs[i].created_at) > messageDate) {
          insertIndex = i
          break
        }
        insertIndex = i + 1
      }
      currentDMMessages.value.splice(insertIndex, 0, message)

      setTimeout(() => {
        highlightedMessageId.value = messageId
      }, 100)

      return true
    } catch (error) {
      debug.error('Error jumping to DM message:', error)
      return false
    }
  }

  const fetchReplyMessage = async (messageId: string): Promise<Message | null> => {
    if (replyMessageCache.value.has(messageId)) {
      return replyMessageCache.value.get(messageId)!
    }

    if (fetchingReplyMessages.value.has(messageId)) {
      return new Promise((resolve) => {
        const checkCache = () => {
          if (replyMessageCache.value.has(messageId)) {
            resolve(replyMessageCache.value.get(messageId)!)
          } else if (!fetchingReplyMessages.value.has(messageId)) {
            resolve(null)
          } else {
            setTimeout(checkCache, 50)
          }
        }
        checkCache()
      })
    }

    fetchingReplyMessages.value.add(messageId)

    try {
      const message = await _fetchSingleMessage(messageId)
      
      if (!message) {
        debug.error('❌ DM reply message not found:', messageId)
        return null
      }

      replyMessageCache.value.set(messageId, message)
      return message
    } catch (error) {
      debug.error('❌ Error fetching DM reply message:', error)
      return null
    } finally {
      fetchingReplyMessages.value.delete(messageId)
    }
  }

  const _fetchSingleMessage = async (messageId: string): Promise<Message | null> => {
    try {
      const { data: message, error } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .single()

      if (error || !message) {
        return null
      }

      // Reactions load via MessageService batch fetch, not per-message here.
      // Individual fetches removed for performance

      try {
        ensureMessageEmbeds(message)
      } catch (fetchError) {
        debug.warn('Failed to prepare embeds for DM reply message:', fetchError)
      }

      return message
    } catch (error) {
      debug.error('Error in _fetchSingleMessage:', error)
      return null
    }
  }

  /**
   * Initialize DM environment with configurable loading strategies:
   * - 'lazy': User profiles load only on hover (maximum performance, placeholder UX)
   * - 'partial': Load user profiles for 20 most recent conversations immediately (balanced)
   * - 'immediate': Load ALL user profiles right away (best UX, more database load)
   */
  const initializeDMEnvironment = async (userId: string, forceRefresh = false, metadataOnly = false, loadStrategy: 'lazy' | 'partial' | 'immediate' = 'partial') => {
    debug.log('📬 initializeDMEnvironment called:', { userId, forceRefresh, metadataOnly, loadStrategy, existingConversations: conversations.value.length })
    
    if (isInitializing.value && !forceRefresh) {
      debug.log('🔄 DM initialization already in progress, skipping duplicate')
      return
    }
    
    isInitializing.value = true
    
    try {
      cleanupRealtimeSubscriptions()
      
      // Cold cache (or explicit refresh): block on the fetch so the loader
      // shows. Warm cache: render what we have immediately and revalidate in
      // the background (stale-while-revalidate) so the user never stares at a
      // spinner when we already have the list.
      const hasCache = conversations.value.length > 0
      const runFetch = () => metadataOnly
        ? fetchUserConversationsMetadata(userId, loadStrategy)
        : fetchUserConversations(userId)

      if (forceRefresh || !hasCache) {
        debug.log('📬 Fetching conversations (blocking):', { metadataOnly, hasCache, forceRefresh })
        await runFetch()
        debug.log('📬 After fetch, conversations count:', conversations.value.length)
      } else {
        debug.log('📬 Warm cache - revalidating conversations in background')
        void runFetch().catch(err => debug.warn('Background conversation revalidation failed:', err))
      }
      
      await setupRealtimeSubscriptions(userId)
    } catch (error) {
      debug.error('Failed to initialize DM environment:', error)
    } finally {
      isInitializing.value = false
    }
  }

  // When a batched/cached conversation list arrives, make sure the conversation
  // the user is currently viewing isn't dropped. On a page refresh that lands
  // directly on /dm/:id, fetchConversationDetails pushes that one conversation
  // first; if the batched metadata query (limited to 50 unordered rows) doesn't
  // include it, replacing the array wholesale made the open conversation vanish
  // from the sidebar. Re-append it instead of letting the cache overwrite it.
  const preserveCurrentConversation = (next: DMConversation[]): DMConversation[] => {
    const id = currentConversationId.value
    if (!id || next.some(c => c.id === id)) return next
    const existing = conversations.value.find(c => c.id === id)
    return existing ? [existing, ...next] : next
  }

  const fetchUserConversationsMetadata = async (userId: string, loadStrategy: 'lazy' | 'partial' | 'immediate' = 'partial') => {
    if (pendingConversationListFetch.value) {
      debug.log('🔄 Conversation metadata fetch already in progress, waiting...')
      await pendingConversationListFetch.value
      return
    }
    
    const fetchPromise = (async () => {
    try {
      loadingConversations.value = true
      debug.log('📬 fetchUserConversationsMetadata: Starting fetch for user:', userId)

      // Single-round-trip fast path: profiles/unread/mute come embedded, so
      // none of the follow-up queries below (nor the loadStrategy profile
      // hydration) are needed. Legacy waterfall below is the fallback.
      const rpcConversations = await _fetchConversationsViaRpc()
      if (rpcConversations) {
        conversations.value = preserveCurrentConversation(rpcConversations)
        return
      }

      const { data: participations, error: participationError } = await supabase
        .from('conversation_participants')
        .select(`
          conversation_id,
          hidden_at,
          conversations!inner(
            id,
            created_at,
            type,
            name,
            updated_at,
            metadata
          )
        `)
        .eq('user_id', userId)
        .is('left_at', null)
        // Fetch ALL of the user's conversations (matching the full-fetch path).
        // The previous `.limit(50)` with NO ordering meant that, for users with
        // more than 50 conversations, an arbitrary 50 were returned - so a
        // recently-active conversation could be missing from the sidebar
        // (e.g. open a server channel, refresh, then switch to DMs). Ordering
        // is deterministic via joined_at; the list is re-sorted by last
        // activity client-side in `sortedConversations`.
        .order('joined_at', { ascending: false })

      debug.log('📬 fetchUserConversationsMetadata: Query result:', { 
        participations: participations?.length || 0, 
        error: participationError?.message || 'none' 
      })

      if (participationError) {
        debug.error('❌ Error fetching conversation metadata:', participationError)
        return
      }

      if (!participations || participations.length === 0) {
        debug.log('📬 fetchUserConversationsMetadata: No conversations found for user')
        // Don't clobber the conversation being viewed (loaded directly via URL)
        // just because the batch query came back empty/raced.
        conversations.value = preserveCurrentConversation([])
        return
      }

      const conversationIds = participations.map(p => {
        const conv = Array.isArray(p.conversations) ? p.conversations[0] : p.conversations
        return conv.id
      })

      const { data: participantData, error: participantError } = await supabase
        .from('conversation_participants')
        .select('conversation_id, user_id')
        .in('conversation_id', conversationIds)
        .neq('user_id', userId)
        .is('left_at', null)

      if (participantError) {
        debug.warn('⚠️ Error fetching participant data:', participantError)
      }

      const participantsByConv = new Map<string, string[]>()
      if (participantData) {
        for (const participant of participantData) {
          const convId = participant.conversation_id
          if (!participantsByConv.has(convId)) {
            participantsByConv.set(convId, [])
          }
          participantsByConv.get(convId)!.push(participant.user_id)
        }
      }

      // Bound the scan to the most recent messages across all conversations
      // (same heuristic as the full-fetch path) so this stays cheap now that
      // we no longer cap the number of conversations.
      const lastMessageScanLimit = Math.min(conversationIds.length * 5, 1000)
      const { data: lastMessages, error: messagesError } = await supabase
        .from('messages')
        .select('conversation_id, content, created_at, user_id')
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: false })
        .limit(lastMessageScanLimit)

      if (messagesError) {
        debug.warn('⚠️ Error fetching last messages for preview:', messagesError)
      }

      const lastMessagesByConv = new Map<string, any>()
      if (lastMessages) {
        for (const message of lastMessages) {
          if (!lastMessagesByConv.has(message.conversation_id)) {
            lastMessagesByConv.set(message.conversation_id, message)
          }
        }
      }

      const processedConversations: DMConversation[] = participations
        .map((participation): DMConversation | null => {
        const conversation = Array.isArray(participation.conversations) 
          ? participation.conversations[0] 
          : participation.conversations

        const otherParticipants = participantsByConv.get(conversation.id) || []
        const primaryOtherUserId = otherParticipants[0]
        const lastMessage = lastMessagesByConv.get(conversation.id)
        const lastActivity = lastMessage?.created_at || conversation.updated_at

        // Drop conversations the user dismissed, unless there's newer activity.
        const hiddenAt = (participation as any).hidden_at as string | null | undefined
        if (isConversationHidden(hiddenAt, lastActivity)) {
          return null
        }

        const metadata = conversation.metadata || {}
        const iconUrl = conversation.type === 'group' ? metadata.icon_url : undefined

        const dmConversation: DMConversation = {
          id: conversation.id,
          created_at: conversation.created_at,
          type: conversation.type || 'direct',
          name: conversation.name,
          icon_url: iconUrl, // For group chat icons only
          hidden_at: hiddenAt ?? null,
          last_activity: lastActivity,
          unread_count: 0, // Will be calculated separately if needed
          participant_count: otherParticipants.length + 1, // +1 for current user
          last_message: lastMessage ? {
            id: '', // Don't need full message ID for preview
            content: lastMessage.content,
            created_at: lastMessage.created_at,
            user_id: lastMessage.user_id,
            conversation_id: lastMessage.conversation_id
          } : undefined,
          // Cast to `any` because `_isPlaceholder` is a runtime hint not on `DMUser`.
          other_user: (primaryOtherUserId ? {
            id: primaryOtherUserId,
            username: '', // Will be loaded on demand
            display_name: '', // Will be loaded on demand
            avatar_url: null, // Will be loaded on demand
            is_online: false, // Will be loaded on demand
            _isPlaceholder: true,
          } : undefined) as any
        }

        return dmConversation
      })
        .filter((c): c is DMConversation => c !== null)

      // MERGE: Preserve existing conversations that have full user data loaded
      // Don't overwrite conversations that were already loaded with full details
      const existingConversationsMap = new Map(
        conversations.value.map(c => [c.id, c])
      )
      
      const mergedConversations = processedConversations.map(newConv => {
        const existing = existingConversationsMap.get(newConv.id)
        if (existing && existing.other_user && !existing.other_user._isPlaceholder) {
          debug.log('📋 Preserving full user data for conversation:', newConv.id)
          return existing
        }
        return newConv
      })
      
      conversations.value = preserveCurrentConversation(mergedConversations)

      const convIds = mergedConversations.map(c => c.id)
      if (convIds.length > 0) {
        const { data: unreadData } = await supabase
          .from('unread_counts')
          .select('conversation_id, unread_messages, unread_mentions')
          .eq('user_id', userId)
          .in('conversation_id', convIds)
          .or('unread_messages.gt.0,unread_mentions.gt.0')

        if (unreadData) {
          for (const row of unreadData) {
            const conv = mergedConversations.find(c => c.id === row.conversation_id)
            if (conv) {
              conv.unread_count = row.unread_messages || 0
            }
          }
        }
      }

      const needsProfileLoad = (conv: DMConversation) =>
        conv.type === 'direct' && (!conv.other_user || conv.other_user._isPlaceholder)

      if (loadStrategy === 'immediate') {
        const allDirectConversations = mergedConversations.filter(needsProfileLoad)
          
        if (allDirectConversations.length > 0) {
          debug.log('🔄 Immediate: Loading all', allDirectConversations.length, 'user profiles')
          await loadMultipleConversationUserProfiles(allDirectConversations.map(c => c.id))
        }
      } else if (loadStrategy === 'partial') {
         const immediateLoadConversations = mergedConversations
           .filter(needsProfileLoad)
           .sort((a, b) => new Date(b.last_activity || b.created_at).getTime() - new Date(a.last_activity || a.created_at).getTime())
           .slice(0, 20)
           
        if (immediateLoadConversations.length > 0) {
          debug.log('🔄 Partial: Loading first', immediateLoadConversations.length, 'user profiles')
          await loadMultipleConversationUserProfiles(immediateLoadConversations.map(c => c.id))
        }
      } else if (loadStrategy === 'lazy') {
        debug.log('🔄 Lazy: Profiles will load on hover')
      }
      
    } catch (error) {
      debug.error('❌ Error fetching conversation metadata:', error)
    } finally {
      loadingConversations.value = false
    }
    })()
    
    pendingConversationListFetch.value = fetchPromise
    try {
      await fetchPromise
    } finally {
      pendingConversationListFetch.value = null
    }
  }

  const fetchConversationDetails = async (conversationId: string, currentUserId: string) => {
      const existingConv = conversations.value.find(c => c.id === conversationId)
      if (existingConv) {
        // For group chats, ensure participants are loaded (metadata loader skips them)
        const needsParticipants = existingConv.type === 'group' && (!existingConv.participants || existingConv.participants.length === 0)
        // For direct chats, ensure other_user isn't a placeholder
        const needsUserData = existingConv.type !== 'group' && existingConv.other_user?._isPlaceholder
        if (!needsParticipants && !needsUserData) {
          return existingConv
        }
      }

    const pendingFetch = pendingConversationDetailsFetch.value.get(conversationId)
    if (pendingFetch) {
      debug.log('🔄 Conversation details fetch already in progress for:', conversationId)
      return pendingFetch
    }
    
    const fetchPromise = (async () => {
    try {
      const { data: participation, error: participationError } = await supabase
        .from('conversation_participants')
        .select(`
          conversation_id,
          role,
          joined_at,
          conversations!inner(
            id,
            created_at,
            type,
            name,
            is_active,
            metadata
          )
        `)
        .eq('user_id', currentUserId)
        .eq('conversation_id', conversationId)
        .is('left_at', null)
        .maybeSingle() // Use maybeSingle to avoid 406 error when no rows

      if (participationError) {
        debug.error('❌ Error fetching conversation:', participationError)
        return null
      }
      
      if (!participation) {
        debug.error('❌ Conversation not found or user not participant')
        return null
      }

      const conversation = Array.isArray(participation.conversations) 
        ? participation.conversations[0] 
        : participation.conversations

      const { data: allParticipants, error: participantsError } = await supabase
        .from('conversation_participants')
        .select('user_id, role, joined_at')
        .eq('conversation_id', conversationId)
        .is('left_at', null)

      if (participantsError) {
        debug.error('Error fetching participants:', participantsError)
      }

      const otherParticipants = (allParticipants || []).filter(p => p.user_id !== currentUserId)
      const participantCount = allParticipants?.length ?? 2

      const convData = {
        conversation_id: conversation.id,
        conversation_name: conversation.name,
        conversation_type: conversation.type || 'direct',
        created_at: conversation.created_at,
        is_active: conversation.is_active,
        participant_count: participantCount,
        icon_url: conversation.metadata?.icon_url,
        other_participants: otherParticipants,
        user_role: participation.role,
        user_joined_at: participation.joined_at
      }

      const processedConv = await _processConversationData(convData, currentUserId)
      if (!processedConv) {
        debug.error('❌ Failed to process conversation data')
        return null
      }

      const existingIdx = conversations.value.findIndex(c => c.id === conversationId)
      if (existingIdx >= 0) {
        conversations.value[existingIdx] = processedConv
      } else {
        conversations.value.push(processedConv)
      }

      return processedConv
    } catch (error) {
      debug.error('Failed to fetch conversation details:', error)
      return null
    }
    })()
    
    pendingConversationDetailsFetch.value.set(conversationId, fetchPromise)
    try {
      return await fetchPromise
    } finally {
      pendingConversationDetailsFetch.value.delete(conversationId)
    }
  }

  const _fetchSpecificConversation = async (conversationId: string) => {
    const { data: convData, error: convError } = await supabase
      .from('conversations')
      .select('id, created_at, type, name')
      .eq('id', conversationId)
      .single()

    if (convError || !convData) {
      debug.error('Error fetching conversation:', convError)
      return null
    }

    return convData
  }

  const initializeDMEnvironmentForDirectAccess = async (userId: string, conversationId?: string) => {
    // This prevents the sidebar from flashing loading state when switching conversations
    const hadConversations = conversations.value.length > 0
    if (!hadConversations) {
      isInitializing.value = true
    }
    
    try {
      if (conversationId) {
        let conversation = conversations.value.find(c => c.id === conversationId)
        
        if (!conversation) {
          debug.log('🎯 Direct DM access: Fetching only target conversation:', conversationId)
          const fetchedConversation = await fetchConversationDetails(conversationId, userId)
          if (fetchedConversation) {
            conversation = fetchedConversation
          }
        }
        
        if (conversation) {
          setCurrentConversation(conversationId)
        }
        
        await setupRealtimeSubscriptions(userId)
        
        if (conversations.value.length <= 1) {
          setTimeout(async () => {
            // Re-check here, not just before the timer: a realtime broadcast
            // (unread:change / conversation:new) can trigger a full conversation
            // -list load in the ~100ms gap. Without this guard we'd run a second,
            // redundant list+participants query that just re-fetches what the
            // sidebar already has.
            if (conversations.value.length > 1 || pendingConversationListFetch.value) {
              debug.log('🔄 Background: sidebar already populated/loading, skipping metadata fetch')
              return
            }
            debug.log('🔄 Background: Loading other conversations for sidebar')
            await fetchUserConversationsMetadata(userId, 'immediate')
          }, 100)
        }
        
        return conversation
      }
      
      await initializeDMEnvironment(userId, false)
      return null
    } catch (error) {
      debug.error('Failed to initialize DM environment for direct access:', error)
      return null
    } finally {
      if (!hadConversations) {
        isInitializing.value = false
      }
    }
  }

  const _normalizeProfileToDMUser = (profile: any): DMUser => {
    const isFederated = !profile.is_local && profile.domain
    return {
      ..._normalizeUserObject(profile),
      handle: isFederated ? `@${profile.username}@${profile.domain}` : `@${profile.username}`,
      is_online: false, // Updated by global presence system in UI
    }
  }

  // Fast path: the whole DM sidebar (conversations + participants with
  // profiles + last message + unread + mute) in ONE round trip via the
  // get_user_conversations RPC. Returns null when the RPC is unavailable
  // (e.g. migration not applied on a self-hosted instance) so callers can
  // fall back to the legacy multi-query load.
  const _fetchConversationsViaRpc = async (): Promise<DMConversation[] | null> => {
    try {
      const { data, error } = await supabase.rpc('get_user_conversations')
      if (error) {
        debug.warn('⚠️ get_user_conversations RPC unavailable, using legacy multi-query load:', error.message)
        return null
      }

      const rows: any[] = Array.isArray(data) ? data : []
      const processed: DMConversation[] = []

      for (const row of rows) {
        const lastMessage = row.last_message || undefined
        const lastActivity = lastMessage?.created_at || row.updated_at || row.created_at

        // Drop conversations the user dismissed, unless there's newer activity.
        if (isConversationHidden(row.hidden_at, lastActivity)) continue

        const type = row.type || 'direct'
        const others: any[] = Array.isArray(row.other_participants) ? row.other_participants : []
        const profiles = others.map(o => o?.profile).filter(Boolean)

        const conversation: DMConversation = {
          id: row.conversation_id,
          created_at: row.created_at,
          type,
          name: row.name || undefined,
          icon_url: type === 'group' ? row.metadata?.icon_url : undefined,
          created_by: row.created_by || undefined,
          hidden_at: row.hidden_at ?? null,
          last_activity: lastActivity,
          participant_count: others.length + 1, // +1 for current user
          unread_count: row.unread_messages || 0,
          is_muted: row.is_muted === true,
          last_message: lastMessage ? ({
            id: lastMessage.id,
            user_id: lastMessage.user_id,
            content: lastMessage.content,
            created_at: new Date(lastMessage.created_at),
            channel_id: '', // Empty string for DMs
            conversation_id: row.conversation_id,
            reactions: [],
            metadata: lastMessage.metadata || {}
          } as unknown as Message) : undefined,
        }

        if (type === 'group') {
          conversation.participants = profiles.map(_normalizeProfileToDMUser)
        } else if (profiles[0]) {
          conversation.other_user = _normalizeProfileToDMUser(profiles[0])
        }

        processed.push(conversation)
      }

      debug.log(`📬 Loaded ${processed.length} conversations via single-round-trip RPC`)
      return processed
    } catch (error) {
      debug.warn('⚠️ get_user_conversations RPC failed, using legacy multi-query load:', error)
      return null
    }
  }

  const fetchUserConversations = async (userId: string) => {
    if (pendingConversationListFetch.value) {
      debug.log('🔄 Conversation list fetch already in progress, waiting...')
      await pendingConversationListFetch.value
      return
    }

    const fetchPromise = (async () => {
    try {
      loadingConversations.value = true

      // Single-round-trip fast path; legacy waterfall below is the fallback.
      const rpcConversations = await _fetchConversationsViaRpc()
      if (rpcConversations) {
        conversations.value = preserveCurrentConversation(rpcConversations)
        return
      }

      const rawConversations = await _fetchRawConversations(userId)
      if (!rawConversations || rawConversations.length === 0) {
        conversations.value = preserveCurrentConversation([])
        return
      }

      const convIds = rawConversations.map((c: any) => c.conversation_id)
      const [, batchLastMessages] = await Promise.all([
        _preloadUserProfiles(rawConversations),
        _fetchBatchLastMessages(convIds)
      ])

      const processedConversations: DMConversation[] = []
      
      for (const conv of rawConversations) {
        const lastMsg = batchLastMessages.get(conv.conversation_id)
        // Skip conversations the user dismissed, unless there's newer activity.
        if (isConversationHidden((conv as any).hidden_at, lastMsg?.created_at)) {
          continue
        }
        const processedConv = await _processConversationData(conv, userId, lastMsg)
        if (processedConv) {
          processedConv.hidden_at = (conv as any).hidden_at ?? null
          processedConversations.push(processedConv)
        }
      }

      try {
        const convIds = processedConversations.map(c => c.id)
        const { data: mutedChannels } = await supabase
          .from('notification_channels')
          .select('conversation_id')
          .eq('user_id', userId)
          .in('conversation_id', convIds)
          .is('channel_id', null)
          .eq('muted', true)

        if (mutedChannels) {
          const mutedSet = new Set(mutedChannels.map(m => m.conversation_id))
          for (const conv of processedConversations) {
            conv.is_muted = mutedSet.has(conv.id)
          }
        }
      } catch (e) {
        debug.error('Failed to batch-load mute states:', e)
      }
      
      conversations.value = preserveCurrentConversation(processedConversations)
      
    } catch (error) {
      debug.error('❌ Failed to fetch conversations via service-like method:', error)
    } finally {
      loadingConversations.value = false
    }
    })()
    
    pendingConversationListFetch.value = fetchPromise
    try {
      await fetchPromise
    } finally {
      pendingConversationListFetch.value = null
    }
  }

  const _fetchRawConversations = async (userId: string) => {
    try {
      const { data: participations, error: participationError } = await supabase
        .from('conversation_participants')
        .select(`
          conversation_id,
          role,
          joined_at,
          hidden_at,
          conversations!inner(
            id,
            created_at,
            type,
            name,
            created_by,
            is_active,
            metadata
          )
        `)
        .eq('user_id', userId)
        .is('left_at', null)
        .order('joined_at', { ascending: false })

      if (participationError) {
        debug.error('Error fetching conversation participations:', participationError)
        return null
      }

      if (!participations || participations.length === 0) {
        return []
      }

      const conversationIds = participations.map(p => {
        const conv = Array.isArray(p.conversations) ? p.conversations[0] : p.conversations
        return conv.id
      })

      const { data: allParticipants, error: participantsError } = await supabase
        .from('conversation_participants')
        .select('conversation_id, user_id, role, joined_at')
        .in('conversation_id', conversationIds)
        .neq('user_id', userId)
        .is('left_at', null)

      if (participantsError) {
        debug.error('Error batch fetching participants:', participantsError)
      }

      const participantsByConversation = new Map<string, Array<{ user_id: string, role: string, joined_at: string }>>()
      if (allParticipants) {
        for (const participant of allParticipants) {
          const convId = participant.conversation_id
          if (!participantsByConversation.has(convId)) {
            participantsByConversation.set(convId, [])
          }
          participantsByConversation.get(convId)!.push({
            user_id: participant.user_id,
            role: participant.role,
            joined_at: participant.joined_at
          })
        }
      }

      const conversationsData = participations.map((participation) => {
        const conversation = Array.isArray(participation.conversations) 
          ? participation.conversations[0] 
          : participation.conversations

        const otherParticipants = participantsByConversation.get(conversation.id) || []
        const participantCount = otherParticipants.length + 1

        return {
          conversation_id: conversation.id,
          conversation_name: conversation.name,
          conversation_type: conversation.type || 'direct',
          created_by: conversation.created_by,
          created_at: conversation.created_at,
          is_active: conversation.is_active,
          participant_count: participantCount,
          icon_url: conversation.metadata?.icon_url, // Icon stored in metadata
          other_participants: otherParticipants,
          user_role: participation.role,
          user_joined_at: participation.joined_at
        }
      })

      return conversationsData
    } catch (error) {
      debug.error('Error in _fetchRawConversations:', error)
      return null
    }
  }

  const _preloadUserProfiles = async (conversationsData: any[]) => {
    const allUserIds = new Set<string>()
    
    conversationsData.forEach(conv => {
      if (conv.other_participants && Array.isArray(conv.other_participants)) {
        conv.other_participants.forEach((participant: any) => {
          if (participant.user_id) {
            allUserIds.add(participant.user_id)
          }
        })
      }
    })

    const serverUsersStore = useServerUsersStore()
    await serverUsersStore.fetchUserProfiles(Array.from(allUserIds))
  }

  const _processConversationData = async (conv: any, userId: string, prefetchedLastMessage?: any): Promise<DMConversation | null> => {
    try {
      const conversationType = conv.conversation_type || 'direct'
      const participantCount = conv.participant_count || 0
      
      const lastMessageData = prefetchedLastMessage !== undefined ? prefetchedLastMessage : await _fetchLastMessage(conv.conversation_id)

      const baseConversation = {
        id: conv.conversation_id,
        created_at: conv.created_at,
        type: conversationType,
        participant_count: participantCount,
        name: conv.conversation_name,
        icon_url: conv.icon_url,
        created_by: conv.created_by,
        last_activity: lastMessageData?.created_at || conv.created_at,
        last_message: lastMessageData ? {
          id: lastMessageData.id,
          user_id: lastMessageData.user_id,
          content: lastMessageData.content,
          created_at: new Date(lastMessageData.created_at),
          channel_id: '', // Empty string for DMs
          conversation_id: conv.conversation_id,
          reactions: [],
          metadata: lastMessageData.metadata || {}
        } : undefined,
        unread_count: 0,
      }

      if (conversationType === 'group') {
        const participantProfiles: any[] = []
        if (conv.other_participants && Array.isArray(conv.other_participants)) {
          const serverUsersStoreLocal = useServerUsersStore()
          const results = await Promise.allSettled(
            conv.other_participants.map(async (participant: any) => {
              const cached = serverUsersStoreLocal.getUserProfile(participant.user_id)
              return cached || await _fetchUserProfile(participant.user_id)
            })
          )
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
              participantProfiles.push(_normalizeUserObject(r.value))
            }
          }
        }

        return {
          ...baseConversation,
          participants: participantProfiles,
          other_user: undefined // No other_user for group chats
        }
      } else {
        let otherUserId: string | null = null
        
        if (conv.other_participants && Array.isArray(conv.other_participants) && conv.other_participants.length > 0) {
          otherUserId = conv.other_participants[0].user_id
        }

        if (!otherUserId) {
          debug.error('❌ No other participant found for conversation:', conv.conversation_id)
          return null
        }
        
        const serverUsersStoreLocal = useServerUsersStore()
        const cachedProfile = serverUsersStoreLocal.getUserProfile(otherUserId)
        const profileData = cachedProfile || await _fetchUserProfile(otherUserId)
        if (!profileData) {
          debug.error('Failed to fetch profile for user:', otherUserId)
          return null
        }

        const isFederated = !profileData.is_local && profileData.domain

        return {
          ...baseConversation,
          other_user: {
            ..._normalizeUserObject(profileData),
            is_online: false, // Will be updated by global presence system in UI
            handle: isFederated ? `@${profileData.username}@${profileData.domain}` : `@${profileData.username}`
          }
        }
      }
    } catch (error) {
      debug.error('Error processing conversation data:', error)
      return null
    }
  }

  const _fetchUserProfile = async (userId: string) => {
    const pendingFetch = pendingProfileFetches.value.get(userId)
    if (pendingFetch) {
      debug.log('🔄 Profile fetch already in progress for:', userId)
      return pendingFetch
    }
    
    const fetchPromise = (async () => {
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, domain, is_local, federated_id')
      .eq('id', userId)
      .single()

    if (profileError) {
      debug.error('Error fetching profile:', profileError)
      return null
    }

    return profileData
    })()
    
    pendingProfileFetches.value.set(userId, fetchPromise)
    try {
      return await fetchPromise
    } finally {
      pendingProfileFetches.value.delete(userId)
    }
  }

  const _normalizeUserObject = (user: any): DMUser => {
    const userId = user.id || user.user_id
    if (!userId) {
      debug.error('User object missing both id and user_id fields:', user)
      throw new Error('Invalid user object: missing ID')
    }

    return {
      id: userId,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      domain: user.domain,
      is_local: user.is_local,
      federated_id: user.federated_id,
      handle: user.handle,
      is_online: false // Will be updated by global presence system in UI
    }
  }

  // FIXED: Use maybeSingle() instead of single() to avoid 406 error when no messages exist
  const _fetchLastMessage = async (conversationId: string) => {
    const { data: lastMessageData, error } = await supabase
      .from('messages')
      .select('id, user_id, content, created_at, metadata')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      debug.warn('⚠️ Error fetching last message for conversation:', conversationId, error)
      return null
    }

    return lastMessageData
  }

  // Batch-fetch last messages for multiple conversations in a single query.
  // Supabase JS doesn't support DISTINCT ON, so we fetch a bounded set of
  // recent messages and deduplicate client-side. Conversations that fall
  // outside the limit will be absent from the map; callers should treat
  // missing keys as "unknown" (not "no messages") and fall back to
  // individual fetches via _fetchLastMessage.
  const _fetchBatchLastMessages = async (conversationIds: string[]): Promise<Map<string, any>> => {
    const result = new Map<string, any>()
    if (!conversationIds.length) return result

    try {
      const limit = Math.min(conversationIds.length * 5, 1000)
      const { data, error } = await supabase
        .from('messages')
        .select('id, user_id, content, created_at, metadata, conversation_id')
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error) {
        debug.warn('⚠️ Batch last messages fetch error:', error)
        return result
      }

      if (data) {
        for (const msg of data) {
          if (!result.has(msg.conversation_id)) {
            result.set(msg.conversation_id, msg)
          }
        }
      }
    } catch (e) {
      debug.error('Failed to batch-fetch last messages:', e)
    }

    return result
  }

  const fetchConversationMessages = async (conversationId: string, beforeMessageId?: string, signal?: AbortSignal) => {
    if (loadingMessages.value && beforeMessageId !== undefined) return

    const fetchKey = beforeMessageId ? `${conversationId}:${beforeMessageId}` : conversationId
    const pendingFetch = pendingMessagesFetch.value.get(fetchKey)
    if (pendingFetch) {
      debug.log('🔄 Message fetch already in progress for:', fetchKey)
      await pendingFetch
      return
    }

    if (beforeMessageId === undefined) {
      if (isCacheValid(conversationId)) {
        debug.log(`Loading from DM cache instantly: ${conversationId}`)
        loadCachedMessages(conversationId)
        // Stale-while-revalidate: catch up on anything that arrived for this
        // conversation while it wasn't the active subscription (same fix as
        // channels - prevents "DM messages don't appear until refresh").
        void revalidateRecentDMMessages(conversationId)
        return
      }
    }

    loadingMessages.value = true
    
    const fetchPromise = (async () => {
    try {
      debug.log('🔄 Loading DM messages via MessageService:', { conversationId, beforeMessageId })
      
      let beforeTimestamp: string | undefined
      if (beforeMessageId) {
        const beforeMessage = currentDMMessages.value.find(m => m.id === beforeMessageId)
        if (beforeMessage) {
          beforeTimestamp = beforeMessage.created_at.toISOString()
        }
      }
      


      const { messages: messagesData, hasMore } = await services.messages.loadConversationMessages(
        conversationId,
        {
          limit: 20,
          before: beforeTimestamp
        }
      )

      // Check if request was cancelled or conversation changed while fetching.
      // BUGS.md H34: previously the stale-conversation guard only ran on the
      // INITIAL load (`beforeMessageId === undefined`). Pagination calls had
      // no guard, so switching DMs mid-fetch would prepend conversation A's
      // history into conversation B's `currentDMMessages` array and cache.
      if (signal?.aborted) {
        throw new Error('Request aborted')
      }
      if (currentConversationId.value !== conversationId) {
        debug.log(`⏭️ Discarding stale DM response for ${conversationId} (current: ${currentConversationId.value})`)
        return
      }

      if (!messagesData) return

      const userIds = new Set<string>();
      messagesData.forEach(message => {
        if (message?.user_id) {
          userIds.add(message.user_id);
        }
      });

      // Kick off profile hydration in parallel WITHOUT blocking the first
      // paint. Previously we awaited this so author names never flashed
      // "Loading..." / "Unknown User", but on a cold DM open it meant the
      // whole message list waited on a profiles round-trip before rendering -
      // a major contributor to the "opens slowly" feel. Names are looked up
      // reactively and fill in a moment later once profiles resolve (the DM
      // participant is typically already cached), and the cache-hit path
      // already renders without this preload, so this stays consistent.
      if (userIds.size > 0) {
        const serverUsersStore = useServerUsersStore();
        void serverUsersStore.fetchMultipleUserProfiles(Array.from(userIds)).catch(() => {});
      }

      
      /*
       * The conditional logic below determines the ordering of messages based on the context:
       * - Initial load (beforeMessageId is undefined): Messages are reversed to display them 
       *   in chronological order (oldest first). This ensures the conversation starts with 
       *   the oldest messages, providing a natural reading flow.
       * - Pagination (beforeMessageId is defined): Messages are kept in their original order 
       *   because they are prepended to the existing list of older messages. Reversing them 
       *   would disrupt the chronological order of the conversation.
       */
      const orderedMessages = messagesData
      const allLoaded = !hasMore

      // Ensure all messages have conversation_id set and include encryption fields.
      // CoreMessageService returns decrypted messages; preserve decrypted flag.
      // `user_id` is `string | undefined` on the source rows; cast the mapped
      // array to `Message[]` to bridge the optional/required mismatch.
      const formattedMessages: Message[] = (orderedMessages.map(msg => ({
        id: msg.id,
        user_id: msg.user_id,
        content: msg.content,
        created_at: new Date(msg.created_at),
        channel_id: '', // Empty string for DMs
        conversation_id: conversationId,
        reply_to: msg.reply_to,
        reactions: msg.reactions || [],
        is_system: msg.is_system,
        metadata: msg.metadata || null,
        encrypted: msg.encrypted || false,
        decrypted: msg.decrypted || false,  // Preserve decrypted flag from CoreMessageService!
        encryption_metadata: msg.encryption_metadata
      })) as unknown as Message[])

      try {
        ensureMessageEmbeds(formattedMessages)
      } catch (error) {
        debug.warn('Failed to prepare DM embeds:', error)
      }

      const decryptedCount = formattedMessages.filter(m => m.decrypted).length
      const encryptedCount = formattedMessages.filter(m => m.encrypted).length
      if (decryptedCount > 0 || encryptedCount > 0) {
        debug.log(`🔐 DM messages: ${decryptedCount} decrypted, ${encryptedCount} still encrypted`)
      }

      if (beforeMessageId === undefined) {
        currentDMMessages.value = formattedMessages
        allMessagesLoaded.value = allLoaded

        evictOldestCache()
        messageCache.value.set(conversationId, {
          messages: [...formattedMessages],
          lastFetchedAt: new Date(),
          oldestMessageId: formattedMessages[0]?.id || null,
          allMessagesLoaded: allLoaded,
          lastModified: new Date(),
        })

        debug.log(`Cached DM messages for conversation: ${conversationId}`)
      } else {
        currentDMMessages.value = [...formattedMessages, ...currentDMMessages.value]
        allMessagesLoaded.value = allLoaded

        const cached = messageCache.value.get(conversationId)
        if (cached) {
          cached.messages = [...formattedMessages, ...cached.messages]
          cached.oldestMessageId = formattedMessages[0]?.id || cached.oldestMessageId
          cached.allMessagesLoaded = allLoaded
          cached.lastFetchedAt = new Date()
        }
      }
      
    } catch (error: any) {
      if (error.message === 'Request aborted') {
        throw new Error('AbortError')
      }
      debug.error('Failed to fetch DM messages:', error)
      throw error
    } finally {
      loadingMessages.value = false
    }
    })()
    
    pendingMessagesFetch.value.set(fetchKey, fetchPromise)
    try {
      await fetchPromise
    } finally {
      pendingMessagesFetch.value.delete(fetchKey)
    }
  }

  const searchUsers = async (query: string, currentUserId: string) => {
    try {
      isSearching.value = true

      // Normalize @prefix: users type "@alice" or "@alice@mastodon.social".
      // The RPC matches against bare usernames + "username@domain"; a leading
      // "@" never matches anything, so strip it here.
      const normalizedQuery = query.trim().replace(/^@+/, '')
      debug.log('🔄 Searching users via service layer:', normalizedQuery)

      if (!normalizedQuery) {
        searchResults.value = []
        return
      }

      const users = await services.activityPub.searchUsers(normalizedQuery, 10)
      
      // `user_id` is not on the `FederatedUser` type; service responses may
      // include it through the legacy shape. Cast to bypass the strict typing.
      debug.log('🔍 Raw search results from service:', users.map((u: any) => ({ id: u.id, user_id: u.user_id, username: u.username })))
      
      const filteredUsers = users
        .map(user => _normalizeUserObject(user))
        .filter(user => user.id !== currentUserId)

      searchResults.value = filteredUsers
      debug.log(`✅ Found ${filteredUsers.length} users via service layer`)
      
    } catch (error) {
      debug.error('❌ Failed to search users via service:', error)
      searchResults.value = []
      
      try {
        debug.log('🔄 Falling back to local user search')
        const normalizedQuery = query.trim().replace(/^@+/, '')
        if (normalizedQuery) {
          await _searchLocalUsers(normalizedQuery, currentUserId)
        }
      } catch (fallbackError) {
        debug.error('❌ Fallback search also failed:', fallbackError)
      }
    } finally {
      isSearching.value = false
    }
  }

  const _searchLocalUsers = async (query: string, currentUserId: string) => {
    const { data: users, error } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, domain, is_local, federated_id')
      .neq('id', currentUserId) // Exclude current user
      .eq('is_local', true) // Only search local users
      .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
      .limit(10)

    if (error) throw error

    searchResults.value = (users || []).map(user => ({
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      domain: user.domain,
      is_local: user.is_local,
      federated_id: user.federated_id,
      handle: user.is_local ? user.username : `${user.username}@${user.domain}`,
      is_online: false
    }))
  }

  const createOrGetConversation = async (user1Id: string, user2Id: string): Promise<string | null> => {
    try {
      debug.log('🔄 Creating/getting conversation via service-like method:', { user1Id, user2Id })
      
      const conversationId = await _createOrFindConversation(user1Id, user2Id)
      
      if (conversationId) {
        debug.log('✅ Conversation created/found:', conversationId)

        // Reopening a conversation un-dismisses it (clears any prior hide) so it
        // sticks around in the list even if it has no messages yet. Clear the
        // server-side flag unconditionally - it's a cheap no-op when not hidden.
        const existing = conversations.value.find(c => c.id === conversationId)
        if (existing?.hidden_at) existing.hidden_at = null
        void supabase.rpc('set_conversation_hidden', {
          p_conversation_id: conversationId,
          p_hidden: false,
        }).then(({ error }) => {
          if (error) debug.warn('Failed to clear hidden flag on reopen:', error)
        })

        if (!existing) {
          conversations.value.push({
            id: conversationId,
            created_at: new Date().toISOString(),
            type: 'direct',
            other_user: {
              id: user2Id,
              username: '',
              display_name: '',
              is_online: false,
              _isPlaceholder: true,
            },
          } as DMConversation)
        }

        fetchConversationDetails(conversationId, user1Id).catch(err => {
          debug.error('Background conversation detail fetch failed:', err)
        })
      }

      return conversationId
    } catch (error) {
      debug.error('❌ Failed to create conversation via service-like method:', error)
      return null
    }
  }

  /**
   * Dismiss (hide) a conversation from the current user's DM list without
   * deleting it or leaving. It stays hidden until reopened or a newer message
   * arrives. Optimistically removes it locally, then persists via RPC.
   */
  const hideConversation = async (conversationId: string): Promise<boolean> => {
    const idx = conversations.value.findIndex(c => c.id === conversationId)
    const removed = idx !== -1 ? conversations.value[idx] : null
    if (idx !== -1) {
      conversations.value.splice(idx, 1)
    }

    try {
      const { error } = await supabase.rpc('set_conversation_hidden', {
        p_conversation_id: conversationId,
        p_hidden: true,
      })
      if (error) throw error
      return true
    } catch (error) {
      debug.error('❌ Failed to hide conversation:', error)
      // Roll back the optimistic removal so the UI stays consistent.
      if (removed && !conversations.value.some(c => c.id === conversationId)) {
        conversations.value.splice(idx === -1 ? conversations.value.length : idx, 0, removed)
      }
      return false
    }
  }

  const _createOrFindConversation = async (user1Id: string, user2Id: string): Promise<string | null> => {
    try {
      const { data: conversationId, error } = await supabase
        .rpc('create_or_get_direct_conversation', { 
          user1_uuid: user1Id, 
          user2_uuid: user2Id 
        })

      if (error) {
        debug.error('Error creating/finding conversation:', error)
        return null
      }

      return conversationId
    } catch (error) {
      debug.error('Error in _createOrFindConversation:', error)
      return null
    }
  }

  const sendDMMessage = async (
    conversationId: string,
    userId: string,
    content: MessagePart[],
    replyTo?: string,
    options?: { allowPlaintextFallback?: boolean }
  ): Promise<boolean> => {
    // Create optimistic message. The temp ID carries a random suffix on top of
    // the timestamp so two sends fired within the same millisecond can't
    // collide (a collision would make the second optimistic message dedupe
    // against the first and silently disappear until realtime arrived).
    const tempId = createTempMessageId();
    // `client_nonce` is echoed back on the persisted row (via metadata) and on
    // the realtime INSERT, letting us reconcile the optimistic message reliably
    // even when content differs between optimistic (plaintext) and stored
    // (ciphertext) - the case that previously produced duplicate messages on
    // encrypted conversations when realtime won the race.
    const clientNonce = getRandomId();
    const sendMetadata = { client_nonce: clientNonce };
    const optimisticMessage = {
      id: tempId,
      created_at: new Date(),
      conversation_id: conversationId,
      user_id: userId,
      content: content,
      reply_to: replyTo,
      metadata: { client_nonce: clientNonce },
      sending: true
    };
    
    addMessageToCache(optimisticMessage as any);
    
    try {
      debug.log('🔄 Sending DM message via MessageService:', { conversationId, userId })
      
      const message = await services.messages.sendDMMessage(
        conversationId,
        content,
        replyTo,
        options ? { allowPlaintextFallback: options.allowPlaintextFallback } : undefined,
        sendMetadata
      )

      debug.log('✅ DM message saved to database:', message.id)
      debug.log('📦 DM message data from server:', message)

      _replaceDMTempWithReal(tempId, message, userId, conversationId, content)

      return true
    } catch (error: any) {
      debug.error('❌ Failed to send DM message via service:', error)

      // Encryption policy errors require user consent before retrying - never
      // auto-retry, never silently fall back to plaintext. Remove the
      // optimistic so the timeline doesn't show a phantom "failed" message
      // after the user cancels the fallback prompt; if they accept, the UI
      // re-calls with `allowPlaintextFallback: true` which creates a fresh
      // optimistic.
      const code = (error?.code || error?.message || '').toString()
      const isEncryptionPolicyError =
        code.includes('ENCRYPTION_REQUIRED') ||
        code.includes('ENCRYPTION_LOCKED') ||
        code.includes('ENCRYPTION_UNAVAILABLE') ||
        code.includes('ENCRYPTION_FAILED_NO_FALLBACK')
      if (isEncryptionPolicyError) {
        removeMessageFromCache(tempId)
        throw error
      }

      // Length-limit / structural validation errors are not transient -
      // drop the optimistic and surface immediately so the UI can show
      // "message too long" instead of doomed retries.
      const isPermanentValidationError =
        code.includes('MESSAGE_TOO_LONG') ||
        code.includes('TOO_MANY_ATTACHMENTS') ||
        code.includes('messages_text_length_check') ||
        (code.includes('check constraint') && code.includes('messages_'))
      if (isPermanentValidationError) {
        removeMessageFromCache(tempId)
        throw error
      }

      if (!navigator.onLine) {
        debug.log('📴 Offline - marking DM as failed, will retry when user clicks Retry')
        _markDMMessageFailed(tempId)
        return false
      }

      for (let attempt = 1; attempt <= 2; attempt++) {
        const delay = Math.pow(2, attempt) * 1000
        debug.log(`🔁 Auto-retrying DM send in ${delay}ms (attempt ${attempt}/2)`)
        await new Promise(r => setTimeout(r, delay))

        if (!navigator.onLine) {
          debug.log('📴 Went offline during retry - marking as failed')
          break
        }

        try {
          const retryResult = await services.messages.sendDMMessage(
            conversationId,
            content,
            replyTo,
            options ? { allowPlaintextFallback: options.allowPlaintextFallback } : undefined,
            sendMetadata
          )
          _replaceDMTempWithReal(tempId, retryResult, userId, conversationId, content)
          return true
        } catch (retryError) {
          debug.warn(`🔁 DM retry attempt ${attempt} failed:`, retryError)
        }
      }

      _markDMMessageFailed(tempId)
      return false
    }
  }

  const _markDMMessageFailed = (tempId: string) => {
    const idx = currentDMMessages.value.findIndex(m => m.id === tempId)
    if (idx !== -1) {
      currentDMMessages.value[idx] = { ...currentDMMessages.value[idx], sending: false, failed: true } as any
    }

    messageCache.value.forEach((cache) => {
      const cacheIdx = cache.messages.findIndex(m => m.id === tempId)
      if (cacheIdx !== -1) {
        cache.messages[cacheIdx] = { ...cache.messages[cacheIdx], sending: false, failed: true } as any
        cache.lastModified = new Date()
      }
    })
  }

  const _replaceDMTempWithReal = (tempId: string, message: any, userId: string, conversationId: string, content: MessagePart[]) => {
    const tempIndex = currentDMMessages.value.findIndex(m => m.id === tempId)
    if (tempIndex === -1) return

    const isOwnEncrypted = message.encrypted && message.user_id === userId
    const realMessage: Message = {
      id: message.id,
      user_id: message.user_id,
      content: isOwnEncrypted ? content : message.content,
      created_at: new Date(message.created_at),
      channel_id: '',
      conversation_id: message.conversation_id,
      reply_to: message.reply_to,
      reactions: message.reactions || [],
      is_system: message.is_system,
      metadata: message.metadata || undefined,
      encrypted: message.encrypted || false,
      decrypted: isOwnEncrypted ? true : (message.decrypted || false),
      encryption_metadata: message.encryption_metadata
    }

    try { ensureMessageEmbeds(realMessage) } catch { /* embeds are best-effort */ }

    currentDMMessages.value.splice(tempIndex, 1, realMessage)
    debug.log('✅ Replaced temp DM message with real message:', { tempId, realId: message.id })

    const cached = messageCache.value.get(conversationId)
    if (cached) {
      const cacheIndex = cached.messages.findIndex(m => m.id === tempId)
      if (cacheIndex !== -1) {
        cached.messages.splice(cacheIndex, 1, realMessage)
        cached.lastModified = new Date()
      }
    }
  }

  const retryDMMessage = async (tempId: string, conversationId: string, userId: string, content: MessagePart[], replyTo?: string) => {
    const idx = currentDMMessages.value.findIndex(m => m.id === tempId)
    if (idx === -1) return

    currentDMMessages.value[idx] = { ...currentDMMessages.value[idx], sending: true, failed: false } as any

    try {
      const message = await services.messages.sendDMMessage(conversationId, content, replyTo)
      _replaceDMTempWithReal(tempId, message, userId, conversationId, content)
    } catch (error) {
      debug.error('❌ DM retry failed:', error)
      _markDMMessageFailed(tempId)
    }
  }

  const discardFailedDMMessage = (tempId: string) => {
    removeMessageFromCache(tempId);
  };

  const setCurrentConversation = (conversationId: string | null) => {
    const previousConversationId = currentConversationId.value
    debug.log('🔄 Setting current conversation:', {
      from: previousConversationId,
      to: conversationId
    });
    
    currentConversationId.value = conversationId
    
    if (previousConversationId && previousConversationId !== conversationId) {
      debug.log('🧹 Cleaning up previous conversation subscription:', previousConversationId);
      cleanupConversationSubscription(previousConversationId)
    }
    
    if (conversationId) {
      debug.log('🔔 Setting up new conversation subscription:', conversationId);
      setupConversationSubscription(conversationId)
      
      const conversation = conversations.value.find(c => c.id === conversationId)
      if (conversation) {
        // Only hit the DB when there is actually something to clear. setCurrentConversation
        // runs several times during a load (route setup, switchToConversation, watchers);
        // without this guard each call fires a redundant unread_counts PATCH for a
        // conversation that's already read.
        const hadUnread = (conversation.unread_count || 0) > 0
        conversation.unread_count = 0
        debug.log('📖 Marked conversation as read:', conversationId);
        if (!hadUnread) return
        import('@/services/AuthContextService').then(({ authContextService: acs }) => acs.getCurrentContext()).then(ctx => {
          if (!ctx.isAuthenticated) return
          supabase
            .from('unread_counts')
            .update({
              unread_messages: 0,
              unread_mentions: 0,
              last_read_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('user_id', ctx.profileId)
            .eq('conversation_id', conversationId)
            .then(({ error }) => {
              if (error) debug.warn('Failed to reset DM unread count:', error)
            })
        })
      } else {
        debug.warn('⚠️ Could not find conversation to mark as read:', conversationId);
      }
    } else {
      debug.log('❌ No conversation ID provided, skipping subscription setup');
    }
  }

  const switchToConversation = async (conversationId: string) => {
    setCurrentConversation(conversationId)
    
    if (isCacheValid(conversationId)) {
      debug.log('📂 Loading cached messages instantly for conversation:', conversationId)
      loadCachedMessages(conversationId)
      void revalidateRecentDMMessages(conversationId)
      return true // Indicates instant loading from cache
    } else {
      debug.log('🔄 No valid cache, will need to fetch messages for conversation:', conversationId)
      clearDMMessages()
      return false // Indicates need to fetch from server
    }
  }

  const clearDMMessages = () => {
    currentDMMessages.value = []
    allMessagesLoaded.value = false
  }

  const cleanupRealtimeSubscriptions = () => {
    debug.log('🧹 Cleaning up DM realtime subscriptions')
    
    if (currentSubscription.value) {
      if (typeof currentSubscription.value === 'function') {
        currentSubscription.value()
      } else {
        currentSubscription.value.unsubscribe?.()
      }
      currentSubscription.value = null
    }
    
    dmSubscriptions.value.forEach((subscription, channelName) => {
      debug.log(`🗑️ Removing DM subscription: ${channelName}`)
      if (typeof subscription === 'function') {
        subscription() // Call unsubscribe function from RealtimeConnectionManager
      } else {
      supabase.removeChannel(subscription)
      }
    })
    dmSubscriptions.value.clear()
  }
  
  const cleanupConversationSubscription = (conversationId: string) => {
    const channelName = `dm-conversation-${conversationId}`
    const subscription = dmSubscriptions.value.get(channelName)
    
    if (subscription) {
      debug.log(`🗑️ Cleaning up conversation subscription: ${channelName}`)
      if (typeof subscription === 'function') {
        subscription()
      } else {
        supabase.removeChannel(subscription)
      }
      dmSubscriptions.value.delete(channelName)
    }
  }

  /**
   * Setup global DM realtime subscriptions using RealtimeConnectionManager
   * Includes conversations updates and reactions
   */
  const setupRealtimeSubscriptions = async (userId: string) => {
    try {
      debug.log('🔄 Setting up DM realtime subscriptions for user:', userId)
      
      const { userDataService } = await import('@/services/userDataService')
      const userUpdatedHandler = (event: any) => {
        const { userId: updatedUserId } = event.detail
        
        const updatedConversations = conversations.value.filter(conv =>
          conv.other_user?.id === updatedUserId && !(conv.other_user as any)?._isPlaceholder
        )
        
        if (updatedConversations.length > 0) {
          for (const conv of updatedConversations) {
            loadConversationUserProfile(conv.id)
          }
        }
      }
      _userUpdatedHandler = userUpdatedHandler
      _userDataServiceRef = userDataService
      userDataService.addEventListener('user-updated', userUpdatedHandler)
      

      // Global conversation:new / conversation:updated handlers are registered
      // separately via registerGlobalBroadcastHandlers() (called from BaseLayout)
      // so they persist across route changes - no need to register here.

    } catch (error) {
      debug.error('❌ Error setting up DM realtime subscriptions:', error)
    }
  }

  /**
   * Setup subscription for a specific DM conversation using RealtimeConnectionManager
   * Handles INSERT, UPDATE, DELETE events with automatic reconnection
   */
  const setupConversationSubscription = (conversationId: string) => {
    const channelName = `dm-conversation-${conversationId}`

    // A channel only counts as "already subscribed" if it's registered AND
    // actually connected (or mid-(re)connect). A registered-but-dead channel
    // (error/disconnected) must be rebuilt: otherwise returning to a
    // conversation - e.g. opening a DM notification for the conversation you
    // last viewed - reuses a stale socket and realtime messages never arrive
    // until a full page refresh tears everything down. This disproportionately
    // hit long-lived sessions (instance owner) that rarely refresh.
    const isLive = (name: string): boolean => {
      if (!realtimeConnectionManager.hasSubscription(name)) return false
      const status = realtimeConnectionManager.getSubscriptionStatus(name)
      return status === 'connected' || status === 'connecting' || status === 'reconnecting'
    }

    if (isLive(channelName)) {
      debug.log('📡 Already subscribed to conversation (healthy):', channelName)
      return
    }

    // Tear down any stale/errored registration so the rebuild below recreates
    // it with a fresh channel instead of being skipped by the has-subscription
    // guard further down.
    if (realtimeConnectionManager.hasSubscription(channelName) && !isLive(channelName)) {
      debug.warn('♻️ Rebuilding stale DM message subscription:', channelName)
      realtimeConnectionManager.unsubscribe(channelName)
      dmSubscriptions.value.delete(channelName)
    }
    
    if (currentConversationId.value && currentConversationId.value !== conversationId) {
      cleanupConversationSubscription(currentConversationId.value)
    }

    debug.log('🔄 Setting up conversation subscription for:', conversationId)

    setupEncryptionKeyListener()

    if (!realtimeConnectionManager.hasSubscription(channelName)) {
      const reactionsStore = useReactionsStore()
      const unsubscribe = realtimeConnectionManager.subscribeToTable({
        channelName,
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
        // Private so reaction broadcasts (realtime.send) land on this same channel.
        private: true,
        broadcasts: [
          { event: 'reaction_event', handler: (payload) => void reactionsStore.handleRealtimeUpdate(payload) },
        ],
        
        onInsert: async (payload) => {
          debug.log('🔔 New DM message received:', payload.new)
          
          const message = payload.new as any
          
          if (currentDMMessages.value.findIndex(m => m.id === message.id) !== -1) {
            debug.log('⚠️ Real message already exists, skipping real-time duplicate')
            return
          }
          
          // Reconcile against the optimistic row (race fallback for when
          // realtime beats `_replaceDMTempWithReal`).
          const tempMessageIndex = findOptimisticMatchIndex(currentDMMessages.value as any, message)
          
          if (tempMessageIndex !== -1) {
            debug.warn('⚠️ Temp message still exists during real-time, replacing now')
            let resolvedMessage: Message = {
              id: message.id,
              user_id: message.user_id,
              content: message.content,
              created_at: new Date(message.created_at),
              channel_id: '',
              conversation_id: message.conversation_id,
              reply_to: message.reply_to,
              reactions: message.reactions || [],
              is_system: message.is_system,
              metadata: message.metadata || null,
              encrypted: message.encrypted || false,
              encryption_metadata: message.encryption_metadata
            }
            
            try {
              ensureMessageEmbeds(resolvedMessage)
              if (resolvedMessage.encrypted) {
                const decrypted = await processMessageDecryption([resolvedMessage])
                resolvedMessage = decrypted[0]
              }
            } catch (error) {
              debug.warn('Failed to process DM message:', error)
            }
            
            currentDMMessages.value.splice(tempMessageIndex, 1, resolvedMessage)
            return
          }
          
          let formattedMessage: Message = {
            id: message.id,
            user_id: message.user_id,
            content: message.content,
            created_at: new Date(message.created_at),
            channel_id: '',
            conversation_id: message.conversation_id,
            reply_to: message.reply_to,
            reactions: message.reactions || [],
            is_system: message.is_system,
            metadata: message.metadata || null,
            encrypted: message.encrypted || false,
            encryption_metadata: message.encryption_metadata
          }
          
          try {
            if (formattedMessage.encrypted) {
              const decrypted = await processMessageDecryption([formattedMessage])
              formattedMessage = decrypted[0]
            }
          } catch (error) {
            debug.warn('Failed to decrypt real-time DM message:', error)
          }
          
          addMessageToCache(formattedMessage)
        },
        
        onUpdate: async (payload) => {
          debug.log('🔄 DM message updated:', payload.new)
          const message = payload.new as any
          
          if (message.is_deleted) {
            removeMessageFromCache(message.id)
            debug.log('🗑️ DM message soft-deleted via real-time:', message.id)
            return
          }
          
          let formattedReactions: any[] = []
          if (message.reactions && message.reactions.length > 0) {
            try {
              const { data: reactions, error: reactionsError } = await supabase
                .rpc('get_message_reactions', { message_id: message.id })
              
              if (!reactionsError && reactions) {
                formattedReactions = reactions
              }
            } catch (error) {
              debug.error('Error fetching reactions for updated DM message:', error)
            }
          }
          
          let updatedMessage: Message = {
            id: message.id,
            user_id: message.user_id,
            content: message.content,
            created_at: new Date(message.created_at),
            channel_id: '',
            conversation_id: message.conversation_id,
            reply_to: message.reply_to,
            reactions: formattedReactions,
            is_system: message.is_system,
            metadata: message.metadata || null,
            encrypted: message.encrypted || false,
            encryption_metadata: message.encryption_metadata
          }
          
          try {
            if (updatedMessage.encrypted) {
              const decrypted = await processMessageDecryption([updatedMessage])
              updatedMessage = decrypted[0]
            }
          } catch (error) {
            debug.warn('Failed to decrypt updated DM message:', error)
          }
          
          updateMessageInCache(message.id, updatedMessage)
        },
        
        onDelete: (payload) => {
          debug.log('🗑️ DM message deleted:', payload.old)
          const payloadOld = payload.old as any
          removeMessageFromCache(payloadOld.id)
        },
        
        onStatusChange: (status, name) => {
          debug.log(`📡 ${name} status: ${status}`)
          dmConnectionStatus.value = status
        },
        
        onReconnected: async () => {
          debug.log('🔀 DM conversation reconnected, gap-filling for:', conversationId)
          try {
            if (currentDMMessages.value.length > 0) {
              const newestMsg = currentDMMessages.value[currentDMMessages.value.length - 1]
              const newestTime = newestMsg.created_at instanceof Date
                ? newestMsg.created_at.toISOString()
                : String(newestMsg.created_at)
              const { data: recent, error } = await supabase
                .from('messages')
                .select('*')
                .eq('conversation_id', conversationId)
                .gt('created_at', newestTime)
                .order('created_at', { ascending: true })
                .limit(50)
              if (!error && recent) {
                let added = 0
                for (const msg of recent) {
                  if (!currentDMMessages.value.some(m => m.id === msg.id)) {
                    const formatted: Message = {
                      id: msg.id,
                      user_id: msg.user_id,
                      content: msg.content,
                      created_at: new Date(msg.created_at),
                      channel_id: '',
                      conversation_id: msg.conversation_id,
                      reply_to: msg.reply_to,
                      reactions: msg.reactions || [],
                      is_system: msg.is_system,
                      metadata: msg.metadata || null,
                      encrypted: msg.encrypted || false,
                      encryption_metadata: msg.encryption_metadata
                    }
                    insertMessageSorted(currentDMMessages.value, formatted)
                    added++
                  }
                }
                if (added > 0) {
                  debug.log(`✅ DM gap-fill: added ${added} missed messages`)
                }
              }
            }
          } catch (err) {
            debug.error('❌ DM gap-fill failed:', err)
          }
        }
      })

      currentSubscription.value = unsubscribe
      dmSubscriptions.value.set(channelName, unsubscribe)
    }

    debug.log(`📝 Stored DM subscription for ${channelName}, total subscriptions: ${dmSubscriptions.value.size}`)
  }
  
  // eslint-disable-next-line unused-imports/no-unused-vars
  const connectionStatus = ref<ConnectionStatus>('disconnected')

  const updateConversationFromMessage = (message: any) => {
    const conversation = conversations.value.find(c => c.id === message.conversation_id)
    if (conversation) {
      conversation.last_activity = message.created_at
      conversation.last_message = {
        id: message.id,
        user_id: message.user_id,
        content: message.content,
        created_at: new Date(message.created_at),
        channel_id: '', // Empty string for DMs
        conversation_id: message.conversation_id,
        reactions: []
      }
      
      // Unread count is managed by DB trigger (handle_new_dm_unread).
      // Only update locally for instant UI feedback when not viewing this conversation.
      const currentUser = userDataService.getCurrentUser()
      const currentUserId = currentUser?.id

      if (message.user_id !== currentUserId && currentConversationId.value !== message.conversation_id) {
        conversation.unread_count = (conversation.unread_count || 0) + 1
      }
      
      debug.log('✅ Updated conversation from new message')
    }
  }

  /**
   * Register global broadcast handlers for conversation:new and conversation:updated.
   * Called once from BaseLayout during app init - persists across route changes.
   */
  const registerGlobalBroadcastHandlers = async (userId: string) => {
    if (_globalBroadcastRegistered) return

    const { authContextService } = await import('@/services/AuthContextService')
    const ctx = await authContextService.getCurrentContext()
    if (!ctx.isAuthenticated) return

    userEventChannel.connect(ctx.profileId)

    const unsubNew = userEventChannel.on('conversation:new', (data) => {
      debug.log('🔔 Global: new conversation broadcast:', data.conversation_id)
      fetchUserConversations(userId)
    })

    const unsubUpdated = userEventChannel.on('conversation:updated', (data) => {
      debug.log('🔔 Global: conversation updated broadcast:', data.conversation_id, data.changes)
      const conv = conversations.value.find(c => c.id === data.conversation_id)
      if (conv && data.changes) {
        if ('name' in data.changes) {
          conv.name = data.changes.name || null
        }
        if (data.changes.metadata !== undefined) {
          conv.icon_url = data.changes.metadata?.icon_url
        }
      }
    })

    // BUGS.md #4 - DM sidebar wasn't picking up new messages in
    // conversations the user wasn't currently viewing. The DB already
    // broadcasts `unread:change` on `user:{profileId}` whenever an
    // `unread_messages_view` row changes, but `useDM` never listened for
    // it (only `useUnreadCounts` did, and that store isn't used by the
    // DM sidebar). Patch the matching conversation's `unread_count` and
    // bump `last_activity` so the sort order reflects the new message
    // without needing a full refetch / page refresh.
    const unsubUnread = userEventChannel.on('unread:change', (data: any) => {
      const payload = data?.count || data
      const conversationId = payload?.conversation_id
      if (!conversationId) return
      const conv = conversations.value.find(c => c.id === conversationId)
      if (!conv) {
        // Brand-new conversation we don't have locally - refetch the list
        // so it shows up. This complements `conversation:new` which also
        // triggers a refetch but only fires for genuinely new
        // conversations, not for the first message in an existing one.
        fetchUserConversations(userId).catch(err => debug.warn('unread:change refetch failed:', err))
        return
      }
      const unread = typeof payload.unread_messages === 'number'
        ? payload.unread_messages
        : (conv.unread_count || 0)
      conv.unread_count = unread
      conv.last_activity = new Date().toISOString()
    })

    // When the broadcast channel reconnects after a tab sleep / network
    // drop, the conversation list and unread counts may be stale. Refetch
    // both so the sidebar resyncs without requiring a page refresh.
    const unsubReconnect = userEventChannel.on('_reconnected', () => {
      debug.log('🔄 UserEventChannel reconnected - resyncing conversation list')
      fetchUserConversations(userId).catch(err => debug.warn('reconnect refetch failed:', err))
    })

    _globalBroadcastUnsubs = [unsubNew, unsubUpdated, unsubUnread, unsubReconnect]
    _globalBroadcastRegistered = true
    debug.log('✅ Global conversation broadcast handlers registered')
  }

  /**
   * Tear down DM realtime/listeners.
   *
   * @param resetData when true (logout) the conversation list and caches are
   *   wiped. When false (just leaving the chat/DM layout) the conversation list
   *   is preserved so returning to DMs renders the cached list instantly instead
   *   of flashing a "loading conversations" spinner.
   */
  const cleanup = (resetData = true) => {
    debug.log('🧹 Cleaning up DM store', { resetData })
    
    if (_userUpdatedHandler && _userDataServiceRef) {
      _userDataServiceRef.removeEventListener('user-updated', _userUpdatedHandler)
      _userUpdatedHandler = null
      _userDataServiceRef = null
    }
    
    cleanupRealtimeSubscriptions()
    
    _globalBroadcastUnsubs.forEach(unsub => unsub())
    _globalBroadcastUnsubs = []
    _globalBroadcastRegistered = false
    
    // Always drop the active-conversation message state (re-fetched on open).
    currentDMMessages.value = []
    currentConversationId.value = null
    searchResults.value = []
    replyMessageCache.value.clear()
    fetchingReplyMessages.value.clear()

    if (resetData) {
      conversations.value = []
      messageCache.value.clear()
    }
    // Otherwise keep `conversations` (and message cache) as a warm cache.
    
    debug.log('✅ DM store cleaned up')
  }

  
  const processFederatedDM = async (activity: any, note: any) => {
    try {
      debug.log('🌐 Processing federated DM:', { activityId: activity.id, noteId: note.id })
      
      // Validate this is a direct message according to ActivityStreams spec:
      // - All actors in 'to' should be mentioned in 'tag' for "direct" visibility
      const toActors = Array.isArray(activity.to) ? activity.to : [activity.to]
      const mentions = note.tag?.filter((tag: any) => tag.type === 'Mention') || []
      const mentionedActors = mentions.map((mention: any) => mention.href)
      
      const allRecipientsAreMentioned = toActors.every((actor: string) => 
        mentionedActors.includes(actor) || actor === activity.actor
      )
      
      if (!allRecipientsAreMentioned) {
        debug.warn('⚠️ Federated message does not follow direct message mention requirements, may not be a DM')
      }
      
      const senderUrl = activity.actor
      const senderDomain = new URL(senderUrl).hostname
      
      
      return {
        isDirectMessage: allRecipientsAreMentioned,
        senderUrl,
        senderDomain,
        mentions,
        toActors
      }
    } catch (error) {
      debug.error('❌ Failed to process federated DM:', error)
      return null
    }
  }
  
  const validateMentionTag = (tag: any): boolean => {
    return (
      tag &&
      tag.type === 'Mention' &&
      typeof tag.href === 'string' &&
      typeof tag.name === 'string' &&
      tag.name.startsWith('@')
    )
  }
  

  
  const generateActivityPubMentionTags = (
    content: MessagePart[], 
    recipientUrls: string[], 
    instanceDomain: string
  ): any[] => {
    const mentionTags: any[] = []
    const processedUrls = new Set<string>()
    
    content.forEach(part => {
      if (part.type === 'mention' && part.username) {
        const domain = part.domain || instanceDomain
        // `url` is not on the narrowed `MentionContent` type; some legacy paths
        // attach it at runtime, so read via `any`.
        const url = (part as any).url || `https://${domain}/users/${part.username}`
        const name = domain === instanceDomain ? `@${part.username}` : `@${part.username}@${domain}`
        
        if (!processedUrls.has(url)) {
          mentionTags.push({
            type: 'Mention',
            href: url,
            name: name
          })
          processedUrls.add(url)
        }
      }
    })
    
    // For DMs, ensure ALL recipients are mentioned (required for "direct" visibility)
    recipientUrls.forEach(recipientUrl => {
      if (!processedUrls.has(recipientUrl)) {
        try {
          const url = new URL(recipientUrl)
          const domain = url.hostname
          const pathParts = url.pathname.split('/')
          let username = ''
          
          if (pathParts[1] === 'users' && pathParts[2]) {
            username = pathParts[2]
          } else if (pathParts[1]?.startsWith('@')) {
            username = pathParts[1].substring(1)
          } else if (pathParts[1]) {
            username = pathParts[1]
          }
          
          if (username) {
            const name = domain === instanceDomain ? `@${username}` : `@${username}@${domain}`
            mentionTags.push({
              type: 'Mention',
              href: recipientUrl,
              name: name
            })
            processedUrls.add(recipientUrl)
          }
        } catch (error) {
          debug.warn('Failed to parse recipient URL for mention tag:', recipientUrl, error)
        }
      }
    })
    
    return mentionTags
  }

  const debugConversationQueries = async (userId?: string) => {
    const testUserId = userId || '2d06f6ba-4c21-4c84-a963-db65148ac543' // From the logs
    const testConversationId = '06008d5f-7491-47ed-a038-24c323c7d97e' // From user's data
    
    
    debug.log('\n🧪 Test 1: All participants in conversation')
    const { data: allParticipants, error: allError } = await supabase
      .from('conversation_participants')
      .select('*')
      .eq('conversation_id', testConversationId)
    
    debug.log('All participants:', allParticipants, 'Error:', allError)
    
    debug.log('\n🧪 Test 2: Other participants (excluding current user)')
    const { data: otherParticipants, error: otherError } = await supabase
      .from('conversation_participants')
      .select('user_id, role, joined_at')
      .eq('conversation_id', testConversationId)
      .neq('user_id', testUserId)
      .is('left_at', null)
    
    debug.log('Other participants:', otherParticipants, 'Error:', otherError)
    
    debug.log('\n🧪 Test 3: User participations')
    const { data: userConversations, error: userError } = await supabase
      .from('conversation_participants')
      .select(`
        conversation_id,
        role,
        joined_at,
        conversations!inner(
          id,
          created_at,
          type,
          name,
          is_active
        )
      `)
      .eq('user_id', testUserId)
      .is('left_at', null)
      .limit(3)
    
    debug.log('User conversations:', userConversations, 'Error:', userError)
    
    return {
      allParticipants,
      otherParticipants,
      userConversations
    }
  }

  const checkMigrationStatus = async () => {
    debug.log('🔍 Checking conversation migration status...')
    
    try {
      const { error: participantError } = await supabase
        .from('conversation_participants')
        .select('id')
        .limit(1)
      
      if (participantError) {
        debug.error('❌ Migration 013 NOT APPLIED: conversation_participants table missing')
        debug.log('💡 Apply migration: db_schema/migrations/013_multi_participant_conversations.sql')
        debug.log('   (psql or Supabase SQL editor)')
        return { migrationApplied: false, error: participantError }
      }
      
      const { error: convError } = await supabase
        .from('conversations')
        .select('id, type, created_by')
        .limit(1)
      
      if (convError) {
        debug.error('❌ Migration 013 PARTIALLY APPLIED: conversations table missing new columns')
        debug.log('💡 The migration needs to be re-run or completed')
        return { migrationApplied: false, error: convError }
      }
      
      const { count: participantCount } = await supabase
        .from('conversation_participants')
        .select('*', { count: 'exact', head: true })
      
      const { count: conversationCount } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
      
      debug.log('✅ Migration status check:')
      debug.log(`   - conversation_participants table: EXISTS (${participantCount} records)`)
      debug.log(`   - conversations table: EXISTS (${conversationCount} records)`)
      debug.log(`   - Expected participants: ${(conversationCount || 0) * 2}`)
      
      if (participantCount === 0) {
        debug.warn('⚠️ Migration tables exist but no participant data found')
        debug.log('💡 Re-run the migration data population step if needed')
      }
      
      return {
        migrationApplied: true,
        participantCount,
        conversationCount,
        dataMigrated: (participantCount ?? 0) > 0
      }
      
    } catch (error) {
      debug.error('❌ Error checking migration status:', error)
      return { migrationApplied: false, error }
    }
  }


  /**
   * Create a group conversation with multiple participants
   */
  const createGroupConversation = async (options: {
    participantIds: string[] // User IDs
    name?: string
    isPrivate?: boolean
  }): Promise<string | null> => {
    try {
      debug.log('🔄 Creating group conversation:', options)
      
      if (!options.participantIds || options.participantIds.length < 2) {
        debug.error('❌ Need at least 2 participants for group conversation')
        return null
      }

      const currentUserData = userDataService.getCurrentUser()
      if (!currentUserData || !currentUserData.id) {
        debug.error('❌ No current user found for conversation creation')
        return null
      }
      
      debug.log('✅ Current user for conversation creation:', currentUserData.id)

      const { data: conversationId, error: createError } = await supabase.rpc('create_group_conversation', {
        p_creator_user_id: currentUserData.id,
        p_participant_ids: options.participantIds,
        p_conversation_name: options.name || null,
        p_is_private: options.isPrivate ?? true
      })

      if (createError || !conversationId) {
        debug.error('❌ Failed to create conversation:', createError)
        return null
      }

      debug.log('✅ Created conversation:', conversationId)

      ;(async () => {
        try {
          const systemMessageContent = [{
            type: 'text' as const,
            text: `Group conversation created with ${options.participantIds.length} participants`
          }]
          await services.messages.sendDMMessage(
            conversationId,
            systemMessageContent,
            undefined,
            { isSystem: true }
          )
        } catch (systemMessageError) {
          debug.warn('⚠️ Failed to send system message:', systemMessageError)
        }
        await fetchUserConversations(currentUserData.id)
      })()

      return conversationId
      
    } catch (error) {
      debug.error('❌ Failed to create group conversation:', error)
      return null
    }
  }

  /**
   * Add users to an existing conversation (convert 1:1 to group or add to group)
   */
  const addUsersToConversation = async (
    conversationId: string,
    userIds: string[],
    currentUserId: string
  ): Promise<boolean | string> => {
    try {
      debug.log('🔄 Adding users to conversation:', { conversationId, userIds })
      
      const { data: conversation, error: fetchError } = await supabase
        .from('conversations')
        .select('type, created_by')
        .eq('id', conversationId)
        .single()

      if (fetchError) {
        debug.error('❌ Failed to fetch conversation:', fetchError)
        return false
      }

      if (conversation?.type === 'direct') {
        debug.log('🔄 Creating NEW group conversation (preserving original 1:1 chat)')
        
        const { data: currentParticipants, error: participantsError } = await supabase
          .from('conversation_participants')
          .select('user_id')
          .eq('conversation_id', conversationId)

        if (participantsError) {
          debug.error('❌ Failed to fetch current participants:', participantsError)
          return false
        }

        if (!currentParticipants || currentParticipants.length === 0) {
          debug.error('❌ No current participants found for conversation')
          return false
        }

        const allUserIds = [
          ...currentParticipants.filter(p => p.user_id).map(p => p.user_id),
          ...userIds.filter(id => id) // Filter out any undefined values
        ].filter((id, index, arr) => id && arr.indexOf(id) === index) // Remove duplicates and undefined values

        debug.log('🔄 All user IDs for new group:', allUserIds)

        const groupOptions = {
          participantIds: allUserIds,
          name: undefined, // Let the system generate a name
          isPrivate: true // Default to private group
        }

        const newConversationId = await createGroupConversation(groupOptions)
        
        if (newConversationId) {
          debug.log('✅ Created new group conversation:', newConversationId)
          return newConversationId // Return the new conversation ID
        } else {
          return false
        }
      } else {
        debug.log('🔄 Adding users to existing group conversation')
        
        for (const userId of userIds) {
          const { error: addError } = await supabase.rpc('add_user_to_conversation', {
            conversation_uuid: conversationId,
            user_uuid: userId,
            user_role: 'member'
          })

          if (addError) {
            debug.error('❌ Failed to add participant:', addError)
            return false
          }
        }

        try {
          const userProfiles = await Promise.all(
            userIds.map(async (userId) => {
              const { data } = await supabase
                .from('profiles')
                .select('username, display_name')
                .eq('id', userId)
                .single()
              return data
            })
          )

          const userNames = userProfiles
            .filter(Boolean)
            .map(profile => profile?.display_name || profile?.username)
            .join(', ')

          const systemMessageContent = [{
            type: 'text' as const,
            text: `${userNames} ${userIds.length === 1 ? 'was' : 'were'} added to the conversation`
          }]

          await services.messages.sendDMMessage(
            conversationId,
            systemMessageContent,
            undefined,
            { isSystem: true }
          )
        } catch (systemMessageError) {
          debug.warn('⚠️ Failed to send system message:', systemMessageError)
        }

        await fetchUserConversations(currentUserId)

        debug.log('✅ Successfully added users to group conversation')
        return true
      }
      
    } catch (error) {
      debug.error('❌ Failed to add users to conversation:', error)
      return false
    }
  }

  /**
   * Get all participants of a conversation
   */
  const getConversationParticipants = async (conversationId: string): Promise<DMUser[]> => {
    try {
      const { data, error } = await supabase
        .from('conversation_participants')
        .select(`
          user_id,
          role,
          joined_at,
          profiles!conversation_participants_user_id_fkey (
            id, username, display_name, avatar_url, domain, is_local, federated_id
          )
        `)
        .eq('conversation_id', conversationId)
        .is('left_at', null)

      if (error) throw error

      return (data || []).map((participant: any) => {
        const profile = participant.profiles
        return {
          id: profile.id,
          username: profile.username,
          display_name: profile.display_name,
          avatar_url: profile.avatar_url,
          domain: profile.domain,
          is_local: profile.is_local,
          federated_id: profile.federated_id,
          handle: profile.is_local ? `@${profile.username}` : `@${profile.username}@${profile.domain}`
        }
      })
    } catch (error) {
      debug.error('❌ Failed to get conversation participants:', error)
      return []
    }
  }

  /**
   * ActivityPub federation for group DMs
   * 
   * NOTE: Federation is handled AUTOMATICALLY by the federation-backend service.
   * The DatabaseListener.handleNewDM() function handles:
   * 1. Getting all conversation participants
   * 2. Filtering to remote/federated users only
   * 3. Creating private ActivityPub Notes with direct addressing (to: [recipient])
   * 4. Adding proper mention tags for all participants
   * 5. Delivering to each external participant's inbox via DeliveryQueue
   * 6. Handling delivery failures and retries
   * 
   * This client-side function is for validation/logging only.
   * The actual federation happens when a message is inserted into the messages table.
   * 
   * @see federation-backend/src/listeners/DatabaseListener.ts handleNewDM()
   */
  const federateGroupDMMessage = async (
    message: any,
    participants: DMUser[]
  ): Promise<boolean> => {
    try {
      debug.log('🌐 Group DM message ready for federation:', {
        messageId: message.id,
        participantCount: participants.length
      })
      
      const externalParticipants = participants.filter(p => !p.is_local && p.domain)
      
      if (externalParticipants.length === 0) {
        debug.log('📝 All participants are local, no federation needed')
        return true
      }
      
      debug.log('📤 Federation will be handled by backend for external participants:', 
        externalParticipants.map(p => `${p.username}@${p.domain}`)
      )
      
      // Federation is handled automatically by the federation-backend when the message
      // is inserted into the database. The DatabaseListener picks up new DM messages
      // and federates them to all remote participants via ActivityPub.
      // 
      // See: federation-backend/src/listeners/DatabaseListener.ts handleNewDM()
      
      return true
      
    } catch (error) {
      debug.error('❌ Error in group DM federation check:', error)
      return false
    }
  }

  const loadConversationUserProfile = async (conversationId: string): Promise<boolean> => {
    try {
      const index = conversations.value.findIndex(c => c.id === conversationId)
      if (index === -1) return false
      
      const conversation = conversations.value[index]
      if (!conversation?.other_user?._isPlaceholder) {
        return true // Already loaded or no placeholder
      }

      const { userDataService } = await import('@/services/userDataService')
      
      const userProfile = await userDataService.fetchUserProfile(conversation.other_user.id)
      
      if (userProfile) {
        conversations.value[index] = {
          ...conversation,
          other_user: {
            id: userProfile.id,
            username: userProfile.username || userProfile.display_name || 'Unknown',
            display_name: userProfile.display_name,
            avatar_url: userProfile.avatar_url,
            is_online: false, // Will be updated by presence if needed
            domain: userProfile.domain,
            is_local: userProfile.is_local,
            federated_id: userProfile.federated_id,
            handle: userProfile.handle || `@${userProfile.username}${userProfile.domain ? '@' + userProfile.domain : ''}`,
            color: userProfile.color,
            _isPlaceholder: false
          }
        }
        
        return true
      }
      
      return false
    } catch (error) {
      debug.error('❌ Failed to load user profile for conversation:', conversationId, error)
      return false
    }
  }

  const loadMultipleConversationUserProfiles = async (conversationIds: string[]): Promise<void> => {
    try {
      const conversationsToLoad = conversations.value.filter(c => 
        conversationIds.includes(c.id) && (!c.other_user || c.other_user._isPlaceholder)
      )
      
      if (conversationsToLoad.length === 0) return
      
      const userIds = conversationsToLoad
        .map(c => c.other_user?.id)
        .filter((id): id is string => !!id)
      
      if (userIds.length === 0) return
      
      debug.log('🔄 Loading user profiles for', userIds.length, 'conversations')
      
      const { userDataService } = await import('@/services/userDataService')
      
      const userProfilesMap = await userDataService.fetchMultipleUserProfiles(userIds)
      
      debug.log('✅ Loaded profiles:', Object.keys(userProfilesMap).length)
      
      for (const conversation of conversationsToLoad) {
        const userProfile = conversation.other_user?.id ? userProfilesMap[conversation.other_user.id] : null
        
        if (userProfile && conversation.other_user) {
          const index = conversations.value.findIndex(c => c.id === conversation.id)
          if (index !== -1) {
            conversations.value[index] = {
              ...conversations.value[index],
              other_user: {
                id: userProfile.id,
                username: userProfile.username || userProfile.display_name || 'Unknown',
                display_name: userProfile.display_name,
                avatar_url: userProfile.avatar_url,
                is_online: false, // Will be updated by presence if needed
                domain: userProfile.domain,
                is_local: userProfile.is_local,
                federated_id: userProfile.federated_id,
                handle: userProfile.handle || `@${userProfile.username}${userProfile.domain ? '@' + userProfile.domain : ''}`,
                color: userProfile.color,
                _isPlaceholder: false
              }
            }
          }
        }
      }
      
      debug.log('✅ Conversation profiles updated')
      
    } catch (error) {
      debug.error('❌ Failed to batch load user profiles:', error)
    }
  }

  return {
    conversations,
    currentConversationId,
    currentDMMessages,
    searchResults,
    loadingConversations,
    loadingMessages,
    isSearching,
    allMessagesLoaded,
    isInitializing,
    dmConnectionStatus,
    
    getCurrentConversation,
    getSortedConversations,
    getTotalUnreadCount,
    
    isUserOnline,
    isCacheValid,
    loadCachedMessages,
    fetchReplyMessage,
    replyMessageCache,
    
    editMessage,
    deleteMessage,
    jumpToMessage,
    highlightedMessageId,
    initializeDMEnvironment,
    initializeDMEnvironmentForDirectAccess,
    registerGlobalBroadcastHandlers,
    fetchConversationDetails,
    fetchUserConversations,
    fetchUserConversationsMetadata,
    hideConversation,
    fetchConversationMessages,
    searchUsers,
    createOrGetConversation,
    sendDMMessage,
    retryDMMessage,
    discardFailedDMMessage,
    setCurrentConversation,
    switchToConversation,
    clearDMMessages,
    setupConversationSubscription,
    cleanupConversationSubscription,
    cleanupRealtimeSubscriptions,
    cleanup,
    
    loadConversationUserProfile,
    loadMultipleConversationUserProfiles,
    
    createGroupConversation,
    addUsersToConversation,
    getConversationParticipants,
    federateGroupDMMessage,
    
    processFederatedDM,
    validateMentionTag,
    extractMentionsFromMessageParts,
    generateActivityPubMentionTags,
    debugConversationQueries,
    checkMigrationStatus,
    
    updateMessageInCache,
    reprocessEncryptedDMMessages,
    setupEncryptionKeyListener
  }
})