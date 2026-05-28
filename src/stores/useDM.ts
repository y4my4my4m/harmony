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

// Types for DM functionality
export interface DMUser {
  id: string
  username: string
  display_name?: string
  avatar_url?: string
  is_online?: boolean
  last_seen?: string
  // Federated user support
  domain?: string
  is_local?: boolean
  federated_id?: string
  handle?: string
  color?: string // Optional color for UI
  // Optimization: Track if this is placeholder data that needs to be loaded
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
  
  // Group conversation fields
  name?: string // Group name
  icon_url?: string // Group icon
  created_by?: string // Creator user ID
  participants?: DMUser[] // All participants for group chats
}

export interface DMCache {
  messages: Message[]
  lastFetchedAt: Date
  oldestMessageId: string | null
  allMessagesLoaded: boolean
  lastModified: Date
}

export const useDMStore = defineStore('dm', () => {
  // State
  const conversations = ref<DMConversation[]>([])
  const currentConversationId = ref<string | null>(null)
  const currentDMMessages = ref<Message[]>([])
  const searchResults = ref<DMUser[]>([])
  
  // Loading states
  const loadingConversations = ref(false)
  const loadingMessages = ref(false)
  const isSearching = ref(false)
  const allMessagesLoaded = ref(false)
  const isInitializing = ref(false)
  
  // Professional caching system (following useChat pattern)
  const messageCache = ref<Map<string, DMCache>>(new Map())
  const cacheValidityDuration = 5 * 60 * 1000 // 5 minutes
  const maxCacheSize = 50 // Maximum number of conversations to cache
  
  // Realtime subscription management
  const dmSubscriptions = ref<Map<string, any>>(new Map())
  const currentSubscription = ref<any | null>(null)
  
  // Global broadcast handlers (persist across route changes, cleaned up only on logout)
  let _globalBroadcastUnsubs: (() => void)[] = []
  let _globalBroadcastRegistered = false
  
  // Connection status (mirrors useChat pattern)
  const dmConnectionStatus = ref<import('@/services/RealtimeConnectionManager').ConnectionStatus>('disconnected')
  
  // Cache for individual reply messages
  const replyMessageCache = ref<Map<string, Message>>(new Map())
  const fetchingReplyMessages = ref<Set<string>>(new Set())
  
  // =====================================================
  // REQUEST DEDUPLICATION - Prevent duplicate API calls
  // =====================================================
  
  // Track pending conversation list fetches
  const pendingConversationListFetch = ref<Promise<void> | null>(null)
  
  // Track pending conversation detail fetches by conversation ID
  const pendingConversationDetailsFetch = ref<Map<string, Promise<DMConversation | null>>>(new Map())
  
  // Track pending message fetches by conversation ID
  const pendingMessagesFetch = ref<Map<string, Promise<void>>>(new Map())
  
  // Track pending profile fetches by user ID
  const pendingProfileFetches = ref<Map<string, Promise<any>>>(new Map())
  
  // Computed
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

  // Check if user is online using modern user data system
  const isUserOnline = async (userId: string): Promise<boolean> => {
    try {
      const { userDataService } = await import('@/services/userDataService')
      const userData = userDataService.getUser(userId)
      return userData?.isOnline || false
    } catch (error) {
      debug.error('Failed to check user online status:', error)
      // Fallback to searching in cached user data
      const user = searchResults.value.find(u => u.id === userId)
      return user?.is_online || false
    }
  }

  // Cache management methods (following useChat pattern)
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

  const addMessageToCache = (message: Message) => {
    try {
      ensureMessageEmbeds(message)
    } catch (error) {
      debug.warn('Failed to prepare DM message embeds:', error)
    }
    // Add to current messages if it's the current conversation
    if (currentConversationId.value === message.conversation_id) {
      if (!currentDMMessages.value.some(msg => msg.id === message.id)) {
        insertMessageSorted(currentDMMessages.value, message)
      }
    }

    // Update cache
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

    // Update conversation in sidebar
    updateConversationFromMessage(message)
  }

  const updateMessageInCache = (messageId: string, updatedMessage: Message) => {
    // Update current messages
    const currentIndex = currentDMMessages.value.findIndex(msg => msg.id === messageId)
    if (currentIndex !== -1) {
      currentDMMessages.value[currentIndex] = updatedMessage
    }

    // Update all relevant caches
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
        // Only reprocess the matching conversation
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

      // Fallback: reprocess all
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
    // Remove from current messages
    currentDMMessages.value = currentDMMessages.value.filter(msg => msg.id !== messageId)

    // Remove from all caches
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

  // Fetch individual message (for replies that aren't in current message list)
  const fetchReplyMessage = async (messageId: string): Promise<Message | null> => {
    // Check if already cached
    if (replyMessageCache.value.has(messageId)) {
      return replyMessageCache.value.get(messageId)!
    }

    // Check if already being fetched
    if (fetchingReplyMessages.value.has(messageId)) {
      // Wait for the existing fetch to complete
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
      // Use a service-like approach while preserving functionality
      const message = await _fetchSingleMessage(messageId)
      
      if (!message) {
        debug.error('❌ DM reply message not found:', messageId)
        return null
      }

      // Cache the message
      replyMessageCache.value.set(messageId, message)
      return message
    } catch (error) {
      debug.error('❌ Error fetching DM reply message:', error)
      return null
    } finally {
      fetchingReplyMessages.value.delete(messageId)
    }
  }

  // Helper: Service-like method for fetching individual messages
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

      // Note: Reactions are now loaded via batch loading in MessageService
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

  // Actions
  /**
   * Initialize DM environment with configurable loading strategies:
   * - 'lazy': User profiles load only on hover (maximum performance, placeholder UX)
   * - 'partial': Load user profiles for 20 most recent conversations immediately (balanced)
   * - 'immediate': Load ALL user profiles right away (best UX, more database load)
   */
  const initializeDMEnvironment = async (userId: string, forceRefresh = false, metadataOnly = false, loadStrategy: 'lazy' | 'partial' | 'immediate' = 'partial') => {
    debug.log('📬 initializeDMEnvironment called:', { userId, forceRefresh, metadataOnly, loadStrategy, existingConversations: conversations.value.length })
    
    // Prevent duplicate initialization
    if (isInitializing.value && !forceRefresh) {
      debug.log('🔄 DM initialization already in progress, skipping duplicate')
      return
    }
    
    isInitializing.value = true
    
    try {
      // Clean up any existing subscriptions first
      cleanupRealtimeSubscriptions()
      
      // Only fetch conversations if we don't have them or force refresh is requested
      const shouldFetch = forceRefresh || conversations.value.length === 0
      debug.log('📬 Should fetch conversations:', shouldFetch, '(forceRefresh:', forceRefresh, ', existing:', conversations.value.length, ')')
      
      if (shouldFetch) {
        if (metadataOnly) {
          debug.log('📬 Fetching conversation metadata...')
          await fetchUserConversationsMetadata(userId, loadStrategy)
        } else {
          debug.log('📬 Fetching full conversations...')
          await fetchUserConversations(userId)
        }
        debug.log('📬 After fetch, conversations count:', conversations.value.length)
      }
      
      // Set up realtime subscriptions (always needed for new messages/updates)
      await setupRealtimeSubscriptions(userId)
    } catch (error) {
      debug.error('Failed to initialize DM environment:', error)
    } finally {
      isInitializing.value = false
    }
  }

  // ⚡ OPTIMIZED: Fetch only conversation metadata (no message content, configurable user profile loading)
  // For faster initial load when user isn't actively viewing DMs
  const fetchUserConversationsMetadata = async (userId: string, loadStrategy: 'lazy' | 'partial' | 'immediate' = 'partial') => {
    // REQUEST DEDUPLICATION: If already fetching, wait for that request
    if (pendingConversationListFetch.value) {
      debug.log('🔄 Conversation metadata fetch already in progress, waiting...')
      await pendingConversationListFetch.value
      return
    }
    
    // Create and track the promise
    const fetchPromise = (async () => {
    try {
      loadingConversations.value = true
      debug.log('📬 fetchUserConversationsMetadata: Starting fetch for user:', userId)

      // Step 1: Get conversation metadata in a single query
      const { data: participations, error: participationError } = await supabase
        .from('conversation_participants')
        .select(`
          conversation_id,
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
        .limit(50) // Reasonable limit for metadata

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
        conversations.value = []
        return
      }

      // Step 2: Get participant counts and primary other user IDs in bulk
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

      // Group participants by conversation for quick lookup
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

      // Step 3: Load last message for each conversation (for preview)
      const { data: lastMessages, error: messagesError } = await supabase
        .from('messages')
        .select('conversation_id, content, created_at, user_id')
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: false })

      if (messagesError) {
        debug.warn('⚠️ Error fetching last messages for preview:', messagesError)
      }

      // Group last messages by conversation ID
      const lastMessagesByConv = new Map<string, any>()
      if (lastMessages) {
        for (const message of lastMessages) {
          if (!lastMessagesByConv.has(message.conversation_id)) {
            lastMessagesByConv.set(message.conversation_id, message)
          }
        }
      }

      // Step 4: Transform to simplified conversation objects (metadata only - NO user profile loading)
      const processedConversations: DMConversation[] = participations.map((participation) => {
        const conversation = Array.isArray(participation.conversations) 
          ? participation.conversations[0] 
          : participation.conversations

        const otherParticipants = participantsByConv.get(conversation.id) || []
        const primaryOtherUserId = otherParticipants[0]
        const lastMessage = lastMessagesByConv.get(conversation.id)

        // Extract icon_url from metadata JSON for group chats
        const metadata = conversation.metadata || {}
        const iconUrl = conversation.type === 'group' ? metadata.icon_url : undefined

        const dmConversation: DMConversation = {
          id: conversation.id,
          created_at: conversation.created_at,
          type: conversation.type || 'direct',
          name: conversation.name,
          icon_url: iconUrl, // For group chat icons only
          last_activity: lastMessage?.created_at || conversation.updated_at,
          unread_count: 0, // Will be calculated separately if needed
          participant_count: otherParticipants.length + 1, // +1 for current user
          // OPTIMIZED: Include last message for preview without loading full message history
          last_message: lastMessage ? {
            id: '', // Don't need full message ID for preview
            content: lastMessage.content,
            created_at: lastMessage.created_at,
            user_id: lastMessage.user_id,
            conversation_id: lastMessage.conversation_id
          } : undefined,
          // OPTIMIZED: No user profile data loaded - just placeholders.
          // Real user data will be loaded lazily when conversation is viewed/hovered.
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

      // MERGE: Preserve existing conversations that have full user data loaded
      // Don't overwrite conversations that were already loaded with full details
      const existingConversationsMap = new Map(
        conversations.value.map(c => [c.id, c])
      )
      
      const mergedConversations = processedConversations.map(newConv => {
        const existing = existingConversationsMap.get(newConv.id)
        // If we have an existing conversation with a non-placeholder user, keep it
        if (existing && existing.other_user && !existing.other_user._isPlaceholder) {
          debug.log('📋 Preserving full user data for conversation:', newConv.id)
          return existing
        }
        return newConv
      })
      
      conversations.value = mergedConversations

      // Fetch DB-backed unread counts for all conversations
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

      // OPTIMIZATION: Different loading strategies for user profiles
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
          // Await to ensure profiles are loaded before we finish
          await loadMultipleConversationUserProfiles(immediateLoadConversations.map(c => c.id))
        }
      } else if (loadStrategy === 'lazy') {
        // Pure lazy loading - everything loads on hover only
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

  // Add method to fetch conversation details using participant system
  // OPTIMIZED: Reduced from 3 queries to 2 queries
  const fetchConversationDetails = async (conversationId: string, currentUserId: string) => {
      // First check if we already have this conversation with full data
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

    // REQUEST DEDUPLICATION: If already fetching this conversation, wait for that request
    const pendingFetch = pendingConversationDetailsFetch.value.get(conversationId)
    if (pendingFetch) {
      debug.log('🔄 Conversation details fetch already in progress for:', conversationId)
      return pendingFetch
    }
    
    // Create and track the promise
    const fetchPromise = (async () => {
    try {
      // Query 1: Get conversation data and verify user is a participant
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

      // Query 2: Get ALL participants (including count from array length)
      const { data: allParticipants, error: participantsError } = await supabase
        .from('conversation_participants')
        .select('user_id, role, joined_at')
        .eq('conversation_id', conversationId)
        .is('left_at', null)

      if (participantsError) {
        debug.error('Error fetching participants:', participantsError)
      }

      // Filter to get other participants and calculate count
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

      // Process conversation using existing helper
      const processedConv = await _processConversationData(convData, currentUserId)
      if (!processedConv) {
        debug.error('❌ Failed to process conversation data')
        return null
      }

      // Add or update in conversations array
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

  // Helper: Service-like method to fetch specific conversation using participant system
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

  // Enhanced initialization for direct DM access
  // OPTIMIZED: When loading directly from URL, only fetch the specific conversation
  // Other conversations load in the background for sidebar
  const initializeDMEnvironmentForDirectAccess = async (userId: string, conversationId?: string) => {
    // Only set initializing if we have NO conversations yet
    // This prevents the sidebar from flashing loading state when switching conversations
    const hadConversations = conversations.value.length > 0
    if (!hadConversations) {
      isInitializing.value = true
    }
    
    try {
      // If we have a specific conversation ID, prioritize loading just that one
      if (conversationId) {
        // Check if conversation already exists in our list
        let conversation = conversations.value.find(c => c.id === conversationId)
        
        // If not found, fetch ONLY this conversation details (not all conversations)
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
        
        // Set up realtime subscriptions (always needed)
        await setupRealtimeSubscriptions(userId)
        
        // DEFER: Load other conversations in background for sidebar (non-blocking)
        // Use 'immediate' strategy to load profiles right away (better UX)
        if (conversations.value.length <= 1) {
          setTimeout(async () => {
            debug.log('🔄 Background: Loading other conversations for sidebar')
            await fetchUserConversationsMetadata(userId, 'immediate')
          }, 100)
        }
        
        return conversation
      }
      
      // No specific conversation - initialize full DM environment
      await initializeDMEnvironment(userId, false)
      return null
    } catch (error) {
      debug.error('Failed to initialize DM environment for direct access:', error)
      return null
    } finally {
      // Only clear initializing if we set it (i.e., we didn't have conversations before)
      if (!hadConversations) {
        isInitializing.value = false
      }
    }
  }

  const fetchUserConversations = async (userId: string) => {
    // REQUEST DEDUPLICATION: If already fetching, wait for that request
    if (pendingConversationListFetch.value) {
      debug.log('🔄 Conversation list fetch already in progress, waiting...')
      await pendingConversationListFetch.value
      return
    }
    
    // Create and track the promise
    const fetchPromise = (async () => {
    try {
      loadingConversations.value = true
      
      // Use service-like helpers to break down complexity
      const rawConversations = await _fetchRawConversations(userId)
      if (!rawConversations || rawConversations.length === 0) {
        conversations.value = []
        return
      }

      // Pre-load all user profiles and batch-fetch last messages in parallel
      const convIds = rawConversations.map((c: any) => c.conversation_id)
      const [, batchLastMessages] = await Promise.all([
        _preloadUserProfiles(rawConversations),
        _fetchBatchLastMessages(convIds)
      ])

      // Process each conversation with pre-fetched data
      const processedConversations: DMConversation[] = []
      
      for (const conv of rawConversations) {
        const lastMsg = batchLastMessages.get(conv.conversation_id)
        const processedConv = await _processConversationData(conv, userId, lastMsg)
        if (processedConv) {
          processedConversations.push(processedConv)
        }
      }

      // Batch-load mute states for all conversations
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
      
      conversations.value = processedConversations
      
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

  // Helper: Service-like method to fetch raw conversation data using participant system
  // OPTIMIZED: Batch queries instead of N+1 pattern
  const _fetchRawConversations = async (userId: string) => {
    try {
      // Step 1: Get user's conversations with metadata in a single query
      const { data: participations, error: participationError } = await supabase
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

      // Extract all conversation IDs for batch queries
      const conversationIds = participations.map(p => {
        const conv = Array.isArray(p.conversations) ? p.conversations[0] : p.conversations
        return conv.id
      })

      // Step 2: BATCH fetch ALL other participants for ALL conversations in ONE query
      const { data: allParticipants, error: participantsError } = await supabase
        .from('conversation_participants')
        .select('conversation_id, user_id, role, joined_at')
        .in('conversation_id', conversationIds)
        .neq('user_id', userId)
        .is('left_at', null)

      if (participantsError) {
        debug.error('Error batch fetching participants:', participantsError)
      }

      // Group participants by conversation_id for O(1) lookup
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

      // Step 3: Transform to the expected format (NO additional queries needed!)
      const conversationsData = participations.map((participation) => {
        const conversation = Array.isArray(participation.conversations) 
          ? participation.conversations[0] 
          : participation.conversations

        const otherParticipants = participantsByConversation.get(conversation.id) || []
        // Participant count = other participants + current user
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

  // Helper: Service-like method to preload user profiles from participant data
  const _preloadUserProfiles = async (conversationsData: any[]) => {
    const allUserIds = new Set<string>()
    
    // Extract user IDs from participant data (other_participants JSONB array)
    conversationsData.forEach(conv => {
      // Add the current user (implied participant)
      // Add other participants from the JSONB array
      if (conv.other_participants && Array.isArray(conv.other_participants)) {
        conv.other_participants.forEach((participant: any) => {
          if (participant.user_id) {
            allUserIds.add(participant.user_id)
          }
        })
      }
    })

    // Ensure all user profiles are loaded in the server users store
    const serverUsersStore = useServerUsersStore()
    await serverUsersStore.fetchUserProfiles(Array.from(allUserIds))
  }

  // Helper: Service-like method to process individual conversation using participant system
  // Accepts optional pre-fetched last message to avoid N+1 queries
  const _processConversationData = async (conv: any, userId: string, prefetchedLastMessage?: any): Promise<DMConversation | null> => {
    try {
      const conversationType = conv.conversation_type || 'direct'
      const participantCount = conv.participant_count || 0
      
      // Use pre-fetched last message if available, otherwise fetch individually (fallback)
      const lastMessageData = prefetchedLastMessage !== undefined ? prefetchedLastMessage : await _fetchLastMessage(conv.conversation_id)

      // Base conversation data
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

      // Handle different conversation types
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
        // For direct conversations, get the other participant (not the current user)
        let otherUserId: string | null = null
        
        if (conv.other_participants && Array.isArray(conv.other_participants) && conv.other_participants.length > 0) {
          // Get the first other participant (for direct messages, should be exactly 1)
          otherUserId = conv.other_participants[0].user_id
        }

        if (!otherUserId) {
          debug.error('❌ No other participant found for conversation:', conv.conversation_id)
          return null
        }
        
        // Try preloaded profile cache first, fall back to fetch
        const serverUsersStoreLocal = useServerUsersStore()
        const cachedProfile = serverUsersStoreLocal.getUserProfile(otherUserId)
        const profileData = cachedProfile || await _fetchUserProfile(otherUserId)
        if (!profileData) {
          debug.error('Failed to fetch profile for user:', otherUserId)
          return null
        }

        // Determine if this is a federated conversation
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

  // Helper: Service-like method to fetch user profile with deduplication
  const _fetchUserProfile = async (userId: string) => {
    // REQUEST DEDUPLICATION: Check if already fetching this profile
    const pendingFetch = pendingProfileFetches.value.get(userId)
    if (pendingFetch) {
      debug.log('🔄 Profile fetch already in progress for:', userId)
      return pendingFetch
    }
    
    // Create and track the promise
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

  // Helper: Normalize user object to ensure consistent ID field
  const _normalizeUserObject = (user: any): DMUser => {
    // Determine the correct ID (prefer 'id' over 'user_id')
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

  // Helper: Service-like method to fetch last message
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

    // REQUEST DEDUPLICATION: For initial loads, check if already fetching this conversation
    const fetchKey = beforeMessageId ? `${conversationId}:${beforeMessageId}` : conversationId
    const pendingFetch = pendingMessagesFetch.value.get(fetchKey)
    if (pendingFetch) {
      debug.log('🔄 Message fetch already in progress for:', fetchKey)
      await pendingFetch
      return
    }

    // For initial load, check cache first - make this synchronous for instant loading
    if (beforeMessageId === undefined) {
      // Simple time-based cache validation (no async database calls)
      if (isCacheValid(conversationId)) {
        debug.log(`Loading from DM cache instantly: ${conversationId}`)
        loadCachedMessages(conversationId)
        return
      }
    }

    // Only set loading state for non-cached messages
    loadingMessages.value = true
    
    // Create and track the promise
    const fetchPromise = (async () => {
    try {
      debug.log('🔄 Loading DM messages via MessageService:', { conversationId, beforeMessageId })
      
      // Use services.messages for consistent loading with service layer
      // Determine cursor for pagination (before timestamp)
      let beforeTimestamp: string | undefined
      if (beforeMessageId) {
        // Get the timestamp of the message for pagination
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

      // Extract unique user IDs from messages and pre-load profiles
      // Service already loads user profiles, but we pre-load for consistency
      const userIds = new Set<string>();
      messagesData.forEach(message => {
        if (message?.user_id) {
          userIds.add(message.user_id);
        }
      });

      // Pre-load all user profiles before updating messages
      // This ensures no "Loading..." or "Unknown User" appears in DM display
      if (userIds.size > 0) {
        const serverUsersStore = useServerUsersStore();
        await serverUsersStore.fetchMultipleUserProfiles(Array.from(userIds));
      }

      // Service already handles reactions loading
      // Messages come with properly formatted reactions from the service
      
      // Service now returns messages in reverse chronological order (newest first)
      // Reverse for chronological display (oldest first)
      /*
       * The conditional logic below determines the ordering of messages based on the context:
       * - Initial load (beforeMessageId is undefined): Messages are reversed to display them 
       *   in chronological order (oldest first). This ensures the conversation starts with 
       *   the oldest messages, providing a natural reading flow.
       * - Pagination (beforeMessageId is defined): Messages are kept in their original order 
       *   because they are prepended to the existing list of older messages. Reversing them 
       *   would disrupt the chronological order of the conversation.
       */
      // Messages now come in correct order (oldest first) from service
      const orderedMessages = messagesData
      const allLoaded = !hasMore

      // Ensure all messages have conversation_id set and include encryption fields.
      // Note: Messages from CoreMessageService are already decrypted, preserve the decrypted flag!
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

      // 🔐 Note: Decryption already happens in CoreMessageService.loadConversationMessages
      // Just log stats for debugging
      const decryptedCount = formattedMessages.filter(m => m.decrypted).length
      const encryptedCount = formattedMessages.filter(m => m.encrypted).length
      if (decryptedCount > 0 || encryptedCount > 0) {
        debug.log(`🔐 DM messages: ${decryptedCount} decrypted, ${encryptedCount} still encrypted`)
      }

      if (beforeMessageId === undefined) {
        // Initial load - update cache and current messages
        currentDMMessages.value = formattedMessages
        allMessagesLoaded.value = allLoaded

        // Update cache
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
        // Loading older messages - append to current
        currentDMMessages.value = [...formattedMessages, ...currentDMMessages.value]
        allMessagesLoaded.value = allLoaded

        // Update cache with new older messages
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

      // Use activityPubService for federated user search (includes local users)
      const users = await services.activityPub.searchUsers(normalizedQuery, 10)
      
      // `user_id` is not on the `FederatedUser` type; service responses may
      // include it through the legacy shape. Cast to bypass the strict typing.
      debug.log('🔍 Raw search results from service:', users.map((u: any) => ({ id: u.id, user_id: u.user_id, username: u.username })))
      
      // Normalize and filter users with consistent ID structure
      const filteredUsers = users
        .map(user => _normalizeUserObject(user))
        .filter(user => user.id !== currentUserId)

      searchResults.value = filteredUsers
      debug.log(`✅ Found ${filteredUsers.length} users via service layer`)
      
    } catch (error) {
      debug.error('❌ Failed to search users via service:', error)
      searchResults.value = []
      
      // Fallback to local search if service fails
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

  // Helper: Fallback local user search
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

        // If conversation already in store, return immediately
        const existing = conversations.value.find(c => c.id === conversationId)
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

        // Fetch full conversation details in the background (don't block navigation)
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

  // Helper: Service-like method for conversation management using new participant system
  const _createOrFindConversation = async (user1Id: string, user2Id: string): Promise<string | null> => {
    try {
      // Use the database function that handles participant system
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
    // Create optimistic message
    const tempId = `temp-${Date.now()}`;
    const optimisticMessage = {
      id: tempId,
      created_at: new Date(),
      conversation_id: conversationId,
      user_id: userId,
      content: content,
      reply_to: replyTo,
      sending: true
    };
    
    // Add optimistic message to display immediately
    addMessageToCache(optimisticMessage as any);
    
    try {
      debug.log('🔄 Sending DM message via MessageService:', { conversationId, userId })
      
      // Use services.messages for consistent DM sending with service layer
      const message = await services.messages.sendDMMessage(
        conversationId,
        content,
        replyTo,
        options ? { allowPlaintextFallback: options.allowPlaintextFallback } : undefined
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

      // Length-limit / structural validation errors are not transient —
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
            options ? { allowPlaintextFallback: options.allowPlaintextFallback } : undefined
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
    
    // Clean up previous conversation subscription
    if (previousConversationId && previousConversationId !== conversationId) {
      debug.log('🧹 Cleaning up previous conversation subscription:', previousConversationId);
      cleanupConversationSubscription(previousConversationId)
    }
    
    // Set up new conversation subscription
    if (conversationId) {
      debug.log('🔔 Setting up new conversation subscription:', conversationId);
      setupConversationSubscription(conversationId)
      
      // Mark conversation as read (both locally and in DB)
      const conversation = conversations.value.find(c => c.id === conversationId)
      if (conversation) {
        conversation.unread_count = 0
        debug.log('📖 Marked conversation as read:', conversationId);
        // Reset DB unread count
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

  // Smart conversation switching that loads cached messages instantly
  const switchToConversation = async (conversationId: string) => {
    // Set the current conversation first (this sets up subscriptions)
    setCurrentConversation(conversationId)
    
    // Check if we have cached messages for instant loading
    if (isCacheValid(conversationId)) {
      debug.log('📂 Loading cached messages instantly for conversation:', conversationId)
      loadCachedMessages(conversationId)
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

  // Enhanced subscription management following useChat pattern
  // Now uses RealtimeConnectionManager for automatic reconnection
  const cleanupRealtimeSubscriptions = () => {
    debug.log('🧹 Cleaning up DM realtime subscriptions')
    
    // Clean up current subscription
    if (currentSubscription.value) {
      if (typeof currentSubscription.value === 'function') {
        currentSubscription.value()
      } else {
        currentSubscription.value.unsubscribe?.()
      }
      currentSubscription.value = null
    }
    
    // Remove all DM-specific subscriptions (both legacy and RealtimeConnectionManager)
    dmSubscriptions.value.forEach((subscription, channelName) => {
      debug.log(`🗑️ Removing DM subscription: ${channelName}`)
      // Check if it's a function (RealtimeConnectionManager unsubscribe) or a channel
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

    // Clean up reactions subscription for this conversation
    const reactionsChannelName = `dm-reactions-${conversationId}`
    if (dmSubscriptions.value.has(reactionsChannelName)) {
      realtimeConnectionManager.unsubscribe(reactionsChannelName)
      dmSubscriptions.value.delete(reactionsChannelName)
    }
  }

  /**
   * Setup global DM realtime subscriptions using RealtimeConnectionManager
   * Includes conversations updates and reactions
   */
  const setupRealtimeSubscriptions = async (userId: string) => {
    try {
      debug.log('🔄 Setting up DM realtime subscriptions for user:', userId)
      
      // Listen to user profile updates from the centralized cache
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
      
      // Get reactions store for handling real-time updates
      const reactionsStore = useReactionsStore()

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
    
    // Check if already fully subscribed (messages + reactions)
    const reactionsChannelName = `dm-reactions-${conversationId}`
    if (realtimeConnectionManager.hasSubscription(channelName) && 
        realtimeConnectionManager.hasSubscription(reactionsChannelName)) {
      debug.log('📡 Already subscribed to conversation:', channelName)
      return
    }
    
    // Clean up existing subscription for different conversation if needed
    if (currentConversationId.value && currentConversationId.value !== conversationId) {
      cleanupConversationSubscription(currentConversationId.value)
    }

    debug.log('🔄 Setting up conversation subscription for:', conversationId)

    setupEncryptionKeyListener()

    // Subscribe to messages
    if (!realtimeConnectionManager.hasSubscription(channelName)) {
      const unsubscribe = realtimeConnectionManager.subscribeToTable({
        channelName,
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
        
        onInsert: async (payload) => {
          debug.log('🔔 New DM message received:', payload.new)
          
          const message = payload.new as any
          
          if (currentDMMessages.value.findIndex(m => m.id === message.id) !== -1) {
            debug.log('⚠️ Real message already exists, skipping real-time duplicate')
            return
          }
          
          const payloadContent = JSON.stringify(message.content)
          const tempMessageIndex = currentDMMessages.value.findIndex(m => 
            m.id.startsWith('temp-') && m.user_id === message.user_id &&
            JSON.stringify(m.content) === payloadContent
          )
          
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

    if (!realtimeConnectionManager.hasSubscription(reactionsChannelName)) {
      const reactionsStore = useReactionsStore()
      const reactionsUnsubscribe = realtimeConnectionManager.subscribeToTable({
        channelName: reactionsChannelName,
        table: 'reactions',
        filter: `conversation_id=eq.${conversationId}`,
        onInsert: (payload) => {
          const messageId = (payload.new as any)?.message_id
          if (messageId && currentDMMessages.value.some(m => m.id === messageId)) {
            reactionsStore.handleRealtimeUpdate(payload)
          }
        },
        onDelete: (payload) => {
          const messageId = (payload.old as any)?.message_id
          if (messageId && currentDMMessages.value.some(m => m.id === messageId)) {
            reactionsStore.handleRealtimeUpdate(payload)
          }
        },
      })
      dmSubscriptions.value.set(reactionsChannelName, reactionsUnsubscribe)
    }
    
    debug.log(`📝 Stored DM subscription for ${channelName}, total subscriptions: ${dmSubscriptions.value.size}`)
  }
  
  // Connection status tracking (managed by RealtimeConnectionManager)
  const connectionStatus = ref<ConnectionStatus>('disconnected')

  // Helper function to update conversation from a new message
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

  const cleanup = () => {
    debug.log('🧹 Cleaning up DM store')
    
    // Remove user-updated listener
    if (_userUpdatedHandler && _userDataServiceRef) {
      _userDataServiceRef.removeEventListener('user-updated', _userUpdatedHandler)
      _userUpdatedHandler = null
      _userDataServiceRef = null
    }
    
    // Cleanup subscriptions
    cleanupRealtimeSubscriptions()
    
    // Cleanup global broadcast handlers
    _globalBroadcastUnsubs.forEach(unsub => unsub())
    _globalBroadcastUnsubs = []
    _globalBroadcastRegistered = false
    
    // Reset state
    conversations.value = []
    currentDMMessages.value = []
    currentConversationId.value = null
    searchResults.value = []
    messageCache.value.clear()
    replyMessageCache.value.clear()
    fetchingReplyMessages.value.clear()
    
    debug.log('✅ DM store cleaned up')
  }

  // =================================================================
  // FEDERATION SUPPORT
  // =================================================================
  
  // Process incoming federated DM according to ActivityStreams specification
  const processFederatedDM = async (activity: any, note: any) => {
    try {
      debug.log('🌐 Processing federated DM:', { activityId: activity.id, noteId: note.id })
      
      // Validate this is a direct message according to ActivityStreams spec:
      // - All actors in 'to' should be mentioned in 'tag' for "direct" visibility
      const toActors = Array.isArray(activity.to) ? activity.to : [activity.to]
      const mentions = note.tag?.filter((tag: any) => tag.type === 'Mention') || []
      const mentionedActors = mentions.map((mention: any) => mention.href)
      
      // Check if all recipients are properly mentioned (required for direct messages)
      const allRecipientsAreMentioned = toActors.every((actor: string) => 
        mentionedActors.includes(actor) || actor === activity.actor
      )
      
      if (!allRecipientsAreMentioned) {
        debug.warn('⚠️ Federated message does not follow direct message mention requirements, may not be a DM')
      }
      
      // Extract sender information from ActivityPub actor
      const senderUrl = activity.actor
      const senderDomain = new URL(senderUrl).hostname
      
      // Find or create sender profile in local database
      // This should integrate with existing federation user management
      
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
  
  // Helper to validate ActivityPub mention format according to spec
  const validateMentionTag = (tag: any): boolean => {
    return (
      tag &&
      tag.type === 'Mention' &&
      typeof tag.href === 'string' &&
      typeof tag.name === 'string' &&
      tag.name.startsWith('@')
    )
  }
  

  
  // Generate proper ActivityPub mention tags for outgoing DMs
  const generateActivityPubMentionTags = (
    content: MessagePart[], 
    recipientUrls: string[], 
    instanceDomain: string
  ): any[] => {
    const mentionTags: any[] = []
    const processedUrls = new Set<string>()
    
    // Add mentions from content
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
          
          // Handle different ActivityPub URL formats
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

  // Add debugging method
  const debugConversationQueries = async (userId?: string) => {
    const testUserId = userId || '2d06f6ba-4c21-4c84-a963-db65148ac543' // From the logs
    const testConversationId = '06008d5f-7491-47ed-a038-24c323c7d97e' // From user's data
    
    // Debug helper for testing conversation queries
    
    // Test 1: Check all participants for the conversation
    debug.log('\n🧪 Test 1: All participants in conversation')
    const { data: allParticipants, error: allError } = await supabase
      .from('conversation_participants')
      .select('*')
      .eq('conversation_id', testConversationId)
    
    debug.log('All participants:', allParticipants, 'Error:', allError)
    
    // Test 2: Check other participants (excluding test user)
    debug.log('\n🧪 Test 2: Other participants (excluding current user)')
    const { data: otherParticipants, error: otherError } = await supabase
      .from('conversation_participants')
      .select('user_id, role, joined_at')
      .eq('conversation_id', testConversationId)
      .neq('user_id', testUserId)
      .is('left_at', null)
    
    debug.log('Other participants:', otherParticipants, 'Error:', otherError)
    
    // Test 3: Check user's conversations
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

  // Check migration status and provide fix instructions
  const checkMigrationStatus = async () => {
    debug.log('🔍 Checking conversation migration status...')
    
    try {
      // Check if conversation_participants table exists
      const { data: participantData, error: participantError } = await supabase
        .from('conversation_participants')
        .select('id')
        .limit(1)
      
      if (participantError) {
        debug.error('❌ Migration 013 NOT APPLIED: conversation_participants table missing')
        debug.log('💡 To fix this, you need to apply the migration:')
        debug.log('   1. Run: psql -d your_database -f db_migrations/013_multi_participant_conversations.sql')
        debug.log('   2. Or apply the migration through your Supabase dashboard')
        return { migrationApplied: false, error: participantError }
      }
      
      // Check if conversations table has the new columns
      const { data: convData, error: convError } = await supabase
        .from('conversations')
        .select('id, type, created_by')
        .limit(1)
      
      if (convError) {
        debug.error('❌ Migration 013 PARTIALLY APPLIED: conversations table missing new columns')
        debug.log('💡 The migration needs to be re-run or completed')
        return { migrationApplied: false, error: convError }
      }
      
      // Check if data was migrated
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
        debug.log('💡 You may need to re-run the migration data population step')
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

  // =================================================================
  // GROUP CHAT FUNCTIONALITY
  // =================================================================

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

      // Get current user for conversation creation
      const currentUserData = userDataService.getCurrentUser()
      if (!currentUserData || !currentUserData.id) {
        debug.error('❌ No current user found for conversation creation')
        return null
      }
      
      debug.log('✅ Current user for conversation creation:', currentUserData.id)

      // Create the conversation using database function (bypasses RLS)
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

      // Return immediately - system message and fetch run in background for responsive UX
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
      
      // First, check if this is a direct conversation
      const { data: conversation, error: fetchError } = await supabase
        .from('conversations')
        .select('type, created_by')
        .eq('id', conversationId)
        .single()

      if (fetchError) {
        debug.error('❌ Failed to fetch conversation:', fetchError)
        return false
      }

      // If it's a direct conversation, create a NEW group conversation (keep original 1:1 intact)
      if (conversation?.type === 'direct') {
        debug.log('🔄 Creating NEW group conversation (preserving original 1:1 chat)')
        
        // Get current participants of the direct conversation
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

        // Create new group conversation with all users (current participants + new users)
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
          // Navigate to the new group conversation
          // The parent component should handle this
          debug.log('✅ Created new group conversation:', newConversationId)
          return newConversationId // Return the new conversation ID
        } else {
          return false
        }
      } else {
        // It's already a group conversation, just add the new participants
        debug.log('🔄 Adding users to existing group conversation')
        
        // Use the database function to add participants (bypasses RLS)
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

        // Add a system message about the new participants
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
          // Don't fail the operation for this
        }

        // Refresh the conversations to show updated participant count
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
      
      // Filter for external (federated) participants
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

  // Load user profiles for conversations using centralized cache
  const loadConversationUserProfile = async (conversationId: string): Promise<boolean> => {
    try {
      const index = conversations.value.findIndex(c => c.id === conversationId)
      if (index === -1) return false
      
      const conversation = conversations.value[index]
      if (!conversation?.other_user?._isPlaceholder) {
        return true // Already loaded or no placeholder
      }

      const { userDataService } = await import('@/services/userDataService')
      
      // Use the centralized cache - this loads from DB if needed, uses cache if available
      const userProfile = await userDataService.fetchUserProfile(conversation.other_user.id)
      
      if (userProfile) {
        // Update conversation with new object to trigger reactivity
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

  // Load user profiles for multiple conversations using centralized cache
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
      
      // Use centralized cache - batch loads missing users, uses cache for existing ones
      const userProfilesMap = await userDataService.fetchMultipleUserProfiles(userIds)
      
      debug.log('✅ Loaded profiles:', Object.keys(userProfilesMap).length)
      
      // Update conversations with cached user data - using array index for proper reactivity
      for (const conversation of conversationsToLoad) {
        const userProfile = conversation.other_user?.id ? userProfilesMap[conversation.other_user.id] : null
        
        if (userProfile && conversation.other_user) {
          // Find the index and update via the array to trigger reactivity
          const index = conversations.value.findIndex(c => c.id === conversation.id)
          if (index !== -1) {
            // Create a new object to trigger Vue reactivity
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

  // Export the conversation store
  return {
    // State
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
    
    // Computed
    getCurrentConversation,
    getSortedConversations,
    getTotalUnreadCount,
    
    // Methods
    isUserOnline,
    isCacheValid,
    loadCachedMessages,
    fetchReplyMessage,
    
    // Actions
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
    
    // Optimization methods
    loadConversationUserProfile,
    loadMultipleConversationUserProfiles,
    
    // Group Chat Functions
    createGroupConversation,
    addUsersToConversation,
    getConversationParticipants,
    federateGroupDMMessage,
    
    // Federation Support
    processFederatedDM,
    validateMentionTag,
    extractMentionsFromMessageParts,
    generateActivityPubMentionTags,
    debugConversationQueries,
    checkMigrationStatus,
    
    // Encryption support
    updateMessageInCache,
    reprocessEncryptedDMMessages,
    setupEncryptionKeyListener
  }
})