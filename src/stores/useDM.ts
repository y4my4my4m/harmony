import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase } from '@/supabase'
import { services } from '@/services'
import type { Message, MessagePart } from '@/types'
import { useServerUsersStore } from './useServerUsers'
import { useReactionsStore } from './useReactions'
import { userDataService } from '@/services/userDataService'
import { extractMentionsFromMessageParts } from '@/utils/unifiedContentProcessing'

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
}

export interface DMConversation {
  id: string
  user1: string
  user2: string
  created_at: string
  last_activity?: string
  last_message?: Message
  unread_count?: number
  other_user?: DMUser
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
  
  // Professional caching system (following useChat pattern)
  const messageCache = ref<Map<string, DMCache>>(new Map())
  const cacheValidityDuration = 5 * 60 * 1000 // 5 minutes
  const maxCacheSize = 50 // Maximum number of conversations to cache
  
  // Realtime subscription management
  const dmSubscriptions = ref<Map<string, any>>(new Map())
  const currentSubscription = ref<any | null>(null)
  
  // Cache for individual reply messages
  const replyMessageCache = ref<Map<string, Message>>(new Map())
  const fetchingReplyMessages = ref<Set<string>>(new Set())
  
  // Computed
  const getCurrentConversation = computed(() => {
    return conversations.value.find(c => c.id === currentConversationId.value)
  })
  
  const getSortedConversations = computed(() => {
    return conversations.value.sort((a, b) => {
      const aTime = new Date(a.last_activity || a.created_at).getTime()
      const bTime = new Date(b.last_activity || b.created_at).getTime()
      return bTime - aTime
    })
  })

  // Check if user is online using modern user data system
  const isUserOnline = async (userId: string): Promise<boolean> => {
    try {
      const { userDataService } = await import('@/services/userDataService')
      const userData = userDataService.getUser(userId)
      return userData?.isOnline || false
    } catch (error) {
      console.error('Failed to check user online status:', error)
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
      console.log(`Evicted DM cache for conversation: ${oldestConversationId}`)
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
      console.log(`Loading cached DM messages instantly: ${conversationId}`)
      currentDMMessages.value = [...cached.messages]
      allMessagesLoaded.value = cached.allMessagesLoaded
    }
  }

  const addMessageToCache = (message: Message) => {
    console.log('🔄 Adding message to DM cache:', {
      messageId: message.id,
      conversationId: message.conversation_id,
      currentConversationId: currentConversationId.value,
      content: message.content
    });
    
    // Add to current messages if it's the current conversation
    if (currentConversationId.value === message.conversation_id) {
      if (!currentDMMessages.value.some(msg => msg.id === message.id)) {
        currentDMMessages.value.push(message)
        console.log('✅ Added new DM message to current conversation, total messages:', currentDMMessages.value.length)
      } else {
        console.log('⚠️ Message already exists in current conversation, skipping')
      }
    } else {
      console.log('📝 Message not for current conversation, current:', currentConversationId.value, 'message:', message.conversation_id)
    }

    // Update cache
    const cached = messageCache.value.get(message.conversation_id!)
    if (cached) {
      if (!cached.messages.some(msg => msg.id === message.id)) {
        cached.messages.push(message)
        cached.lastModified = new Date()
        console.log('💾 Updated message cache for conversation:', message.conversation_id)
      }
    } else {
      console.log('📦 No cache found for conversation, creating new cache:', message.conversation_id)
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
    console.log('🔄 Updated conversation from message')
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
      console.log('🔄 Fetching DM reply message via service-like method:', messageId)
      
      // Use a service-like approach while preserving functionality
      const message = await _fetchSingleMessage(messageId)
      
      if (!message) {
        console.error('❌ DM reply message not found:', messageId)
        return null
      }

      // Cache the message
      replyMessageCache.value.set(messageId, message)
      console.log('✅ DM reply message fetched and cached')
      return message
    } catch (error) {
      console.error('❌ Error fetching DM reply message:', error)
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

      return message
    } catch (error) {
      console.error('Error in _fetchSingleMessage:', error)
      return null
    }
  }

  // Actions
  const initializeDMEnvironment = async (userId: string, forceRefresh = false) => {
    try {
      // Clean up any existing subscriptions first
      cleanupRealtimeSubscriptions()
      
      // Only fetch conversations if we don't have them or force refresh is requested
      if (forceRefresh || conversations.value.length === 0) {
        await fetchUserConversations(userId)
      }
      await setupRealtimeSubscriptions(userId)
    } catch (error) {
      console.error('Failed to initialize DM environment:', error)
    }
  }

  // Add method to fetch conversation details and ensure user profiles are loaded
  const fetchConversationDetails = async (conversationId: string, currentUserId: string) => {
    try {
      console.log('🔄 Fetching conversation details via service-like method:', { conversationId, currentUserId })
      
      // First check if we already have this conversation
      const existingConv = conversations.value.find(c => c.id === conversationId)
      if (existingConv) {
        console.log('✅ Conversation already in cache')
        return existingConv
      }

      // Use service-like helper to fetch specific conversation
      const convData = await _fetchSpecificConversation(conversationId)
      if (!convData) {
        console.error('❌ Conversation not found:', conversationId)
        return null
      }

      // Process conversation using existing helper
      const processedConv = await _processConversationData(convData, currentUserId)
      if (!processedConv) {
        console.error('❌ Failed to process conversation data')
        return null
      }

      // Add to conversations if not already there
      if (!conversations.value.find(c => c.id === conversationId)) {
        conversations.value.push(processedConv)
      }

      console.log('✅ Conversation details fetched and cached')
      return processedConv
    } catch (error) {
      console.error('❌ Failed to fetch conversation details via service-like method:', error)
      return null
    }
  }

  // Helper: Service-like method to fetch specific conversation
  const _fetchSpecificConversation = async (conversationId: string) => {
    const { data: convData, error: convError } = await supabase
      .from('conversations')
      .select('id, user1, user2, created_at')
      .eq('id', conversationId)
      .single()

    if (convError || !convData) {
      console.error('Error fetching conversation:', convError)
      return null
    }

    return convData
  }

  // Enhanced initialization for direct DM access
  const initializeDMEnvironmentForDirectAccess = async (userId: string, conversationId?: string) => {
    try {
      // Initialize basic DM environment (only fetch conversations if not already loaded)
      await initializeDMEnvironment(userId, false)
      
      // If we have a specific conversation ID, ensure it's loaded
      if (conversationId) {
        // Check if conversation already exists in our list
        let conversation = conversations.value.find(c => c.id === conversationId)
        
        // Only fetch conversation details if not found in existing conversations
        if (!conversation) {
          const fetchedConversation = await fetchConversationDetails(conversationId, userId)
          if (fetchedConversation) {
            conversation = fetchedConversation
          }
        }
        
        if (conversation) {
          setCurrentConversation(conversationId)
        }
        return conversation
      }
      
      return null
    } catch (error) {
      console.error('Failed to initialize DM environment for direct access:', error)
      return null
    }
  }

  const fetchUserConversations = async (userId: string) => {
    try {
      loadingConversations.value = true
      console.log('🔄 Fetching user conversations via service-like method:', userId)
      
      // Use service-like helpers to break down complexity
      const rawConversations = await _fetchRawConversations(userId)
      if (!rawConversations || rawConversations.length === 0) {
        conversations.value = []
        return
      }

      // Pre-load all user profiles
      await _preloadUserProfiles(rawConversations)

      // Process each conversation with service-like helpers
      const processedConversations: DMConversation[] = []
      
      for (const conv of rawConversations) {
        const processedConv = await _processConversationData(conv, userId)
        if (processedConv) {
          processedConversations.push(processedConv)
        }
      }
      
      conversations.value = processedConversations
      console.log(`✅ Processed ${processedConversations.length} conversations via service-like method`)
      
    } catch (error) {
      console.error('❌ Failed to fetch conversations via service-like method:', error)
    } finally {
      loadingConversations.value = false
    }
  }

  // Helper: Service-like method to fetch raw conversation data
  const _fetchRawConversations = async (userId: string) => {
    const { data: conversationsData, error: convError } = await supabase
      .from('conversations')
      .select(`
        id,
        user1,
        user2,
        created_at
      `)
      .or(`user1.eq.${userId},user2.eq.${userId}`)
      .order('created_at', { ascending: false })

    if (convError) {
      console.error('Error fetching conversations:', convError)
      return null
    }

    return conversationsData
  }

  // Helper: Service-like method to preload user profiles
  const _preloadUserProfiles = async (conversationsData: any[]) => {
    const allUserIds = new Set<string>()
    conversationsData.forEach(conv => {
      allUserIds.add(conv.user1)
      allUserIds.add(conv.user2)
    })

    // Ensure all user profiles are loaded in the server users store
    const serverUsersStore = useServerUsersStore()
    await serverUsersStore.fetchUserProfiles(Array.from(allUserIds))
  }

  // Helper: Service-like method to process individual conversation
  const _processConversationData = async (conv: any, userId: string): Promise<DMConversation | null> => {
    try {
      const otherUserId = conv.user1 === userId ? conv.user2 : conv.user1
      
      // Get other user's profile
      const profileData = await _fetchUserProfile(otherUserId)
      if (!profileData) {
        console.error('Failed to fetch profile for user:', otherUserId)
        return null
      }

      // Get last message for conversation
      const lastMessageData = await _fetchLastMessage(conv.id)

      // Determine if this is a federated conversation
      const isFederated = !profileData.is_local && profileData.domain

      return {
        id: conv.id,
        user1: conv.user1,
        user2: conv.user2,
        created_at: conv.created_at,
        last_activity: lastMessageData?.created_at || conv.created_at,
        last_message: lastMessageData ? {
          id: lastMessageData.id,
          user_id: lastMessageData.user_id,
          content: lastMessageData.content,
          created_at: new Date(lastMessageData.created_at),
          channel_id: '', // Empty string for DMs
          conversation_id: conv.id,
          reactions: [],
          metadata: lastMessageData.metadata || {}
        } : undefined,
        unread_count: 0, // TODO: Implement proper unread counting
        other_user: {
          id: profileData.id,
          username: profileData.username,
          display_name: profileData.display_name,
          avatar_url: profileData.avatar_url,
          is_online: false, // Will be updated by global presence system in UI
          domain: profileData.domain,
          is_local: profileData.is_local,
          federated_id: profileData.federated_id,
          handle: isFederated ? `@${profileData.username}@${profileData.domain}` : `@${profileData.username}`
        }
      }
    } catch (error) {
      console.error('Error processing conversation data:', error)
      return null
    }
  }

  // Helper: Service-like method to fetch user profile
  const _fetchUserProfile = async (userId: string) => {
    const { data: profileData, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, domain, is_local, federated_id')
      .eq('id', userId)
      .single()

    if (profileError) {
      console.error('Error fetching profile:', profileError)
      return null
    }

    return profileData
  }

  // Helper: Service-like method to fetch last message
  const _fetchLastMessage = async (conversationId: string) => {
    const { data: lastMessageData } = await supabase
      .from('messages')
      .select('id, user_id, content, created_at, metadata')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    return lastMessageData
  }

  const fetchConversationMessages = async (conversationId: string, beforeMessageId?: string, signal?: AbortSignal) => {
    if (loadingMessages.value && beforeMessageId !== undefined) return

    // For initial load, check cache first - make this synchronous for instant loading
    if (beforeMessageId === undefined) {
      // Simple time-based cache validation (no async database calls)
      if (isCacheValid(conversationId)) {
        console.log(`Loading from DM cache instantly: ${conversationId}`)
        loadCachedMessages(conversationId)
        return
      }
    }

    // Only set loading state for non-cached messages
    loadingMessages.value = true
    
    try {
      console.log('🔄 Loading DM messages via MessageService:', { conversationId, beforeMessageId })
      
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
        20, // limit
        beforeTimestamp
      )



      // Check if request was cancelled
      if (signal?.aborted) {
        throw new Error('Request aborted')
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
      
      // Service already returns messages in chronological order (oldest first)
      const reversedMessages = messagesData
      const allLoaded = !hasMore

      // Ensure all messages have conversation_id set
      const formattedMessages: Message[] = reversedMessages.map(msg => ({
        id: msg.id,
        user_id: msg.user_id,
        content: msg.content,
        created_at: new Date(msg.created_at),
        channel_id: '', // Empty string for DMs
        conversation_id: conversationId,
        reply_to: msg.reply_to,
        reactions: msg.reactions || [],
        is_system: msg.is_system
      }))

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

        console.log(`Cached DM messages for conversation: ${conversationId}`)
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
      console.error('Failed to fetch DM messages:', error)
      throw error
    } finally {
      loadingMessages.value = false
    }
  }

  const searchUsers = async (query: string, currentUserId: string) => {
    try {
      isSearching.value = true
      console.log('🔄 Searching users via service layer:', query)
      
      if (!query.trim()) {
        searchResults.value = []
        return
      }

      // Use activityPubService for federated user search (includes local users)
      const users = await services.activityPub.searchUsers(query, 10)
      
      // Filter out current user and convert to DMUser format
      const filteredUsers = users
        .filter(user => user.id !== currentUserId)
        .map(user => ({
          id: user.id,
          username: user.username,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
          domain: user.domain,
          is_local: user.is_local,
          federated_id: user.federated_id,
          handle: user.handle,
          is_online: false // Will be updated by global presence system in UI
        }))

      searchResults.value = filteredUsers
      console.log(`✅ Found ${filteredUsers.length} users via service layer`)
      
    } catch (error) {
      console.error('❌ Failed to search users via service:', error)
      searchResults.value = []
      
      // Fallback to local search if service fails
      try {
        console.log('🔄 Falling back to local user search')
        await _searchLocalUsers(query, currentUserId)
      } catch (fallbackError) {
        console.error('❌ Fallback search also failed:', fallbackError)
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
      console.log('🔄 Creating/getting conversation via service-like method:', { user1Id, user2Id })
      
      // Use service-like helper for conversation management
      const conversationId = await _createOrFindConversation(user1Id, user2Id)
      
      if (conversationId) {
        // Refresh conversations to include the new one
        await fetchUserConversations(user1Id)
        console.log('✅ Conversation created/found:', conversationId)
      }

      return conversationId
    } catch (error) {
      console.error('❌ Failed to create conversation via service-like method:', error)
      return null
    }
  }

  // Helper: Service-like method for conversation management
  const _createOrFindConversation = async (user1Id: string, user2Id: string): Promise<string | null> => {
    try {
      // Check if conversation already exists
      const { data: existingConv, error } = await supabase
        .from('conversations')
        .select('id')
        .or(`and(user1.eq.${user1Id},user2.eq.${user2Id}),and(user1.eq.${user2Id},user2.eq.${user1Id})`)
        .single()

      if (error && error.code !== 'PGRST116') {
        console.error('Error searching for existing conversation:', error)
        return null
      }

      if (existingConv) {
        return existingConv.id
      }

      // Create new conversation if none exists
      const { data: newConv, error: createError } = await supabase
        .from('conversations')
        .insert([
          {
            user1: user1Id,
            user2: user2Id
          }
        ])
        .select('id')
        .single()

      if (createError) {
        console.error('Error creating conversation:', createError)
        return null
      }

      return newConv.id
    } catch (error) {
      console.error('Error in _createOrFindConversation:', error)
      return null
    }
  }

  const sendDMMessage = async (
    conversationId: string,
    userId: string,
    content: MessagePart[],
    replyTo?: string
  ): Promise<boolean> => {
    try {
      console.log('🔄 Sending DM message via MessageService:', { conversationId, userId })
      
      // Use services.messages for consistent DM sending with service layer
      const message = await services.messages.sendDMMessage(
        conversationId,
        content,
        replyTo
      )

      console.log('✅ DM message sent via service layer:', message.id)
      
      // 🎯 DATABASE TRIGGERS NOW HANDLE:
      // 1. DM notifications (handle_message_notifications trigger)
      // 2. Federation delivery (federate_dm_message trigger)
      // No manual frontend calls needed!

      // Real-time subscription will handle adding to cache via addMessageToCache
      // Don't manually add here to prevent duplicates

      return true
    } catch (error: any) {
      console.error('❌ Failed to send DM message via service:', error)
      throw new Error(error.message || 'Failed to send DM message')
    }
  }

  const setCurrentConversation = (conversationId: string | null) => {
    const previousConversationId = currentConversationId.value
    console.log('🔄 Setting current conversation:', {
      from: previousConversationId,
      to: conversationId
    });
    
    currentConversationId.value = conversationId
    
    // Clean up previous conversation subscription
    if (previousConversationId && previousConversationId !== conversationId) {
      console.log('🧹 Cleaning up previous conversation subscription:', previousConversationId);
      cleanupConversationSubscription(previousConversationId)
    }
    
    // Set up new conversation subscription
    if (conversationId) {
      console.log('🔔 Setting up new conversation subscription:', conversationId);
      setupConversationSubscription(conversationId)
      
      // Mark conversation as read
      const conversation = conversations.value.find(c => c.id === conversationId)
      if (conversation) {
        conversation.unread_count = 0
        console.log('📖 Marked conversation as read:', conversationId);
      } else {
        console.warn('⚠️ Could not find conversation to mark as read:', conversationId);
      }
    } else {
      console.log('❌ No conversation ID provided, skipping subscription setup');
    }
  }

  // Smart conversation switching that loads cached messages instantly
  const switchToConversation = async (conversationId: string) => {
    // Set the current conversation first (this sets up subscriptions)
    setCurrentConversation(conversationId)
    
    // Check if we have cached messages for instant loading
    if (isCacheValid(conversationId)) {
      console.log('📂 Loading cached messages instantly for conversation:', conversationId)
      loadCachedMessages(conversationId)
      return true // Indicates instant loading from cache
    } else {
      console.log('🔄 No valid cache, will need to fetch messages for conversation:', conversationId)
      clearDMMessages()
      return false // Indicates need to fetch from server
    }
  }

  const clearDMMessages = () => {
    currentDMMessages.value = []
    allMessagesLoaded.value = false
  }

  // Enhanced subscription management following useChat pattern
  const cleanupRealtimeSubscriptions = () => {
    console.log('🧹 Cleaning up DM realtime subscriptions')
    
    // Clean up current subscription
    if (currentSubscription.value) {
      currentSubscription.value.unsubscribe()
      currentSubscription.value = null
    }
    
    // Remove all DM-specific subscriptions
    dmSubscriptions.value.forEach((subscription, channelName) => {
      console.log(`🗑️ Removing DM subscription: ${channelName}`)
      supabase.removeChannel(subscription)
    })
    dmSubscriptions.value.clear()
  }
  
  const cleanupConversationSubscription = (conversationId: string) => {
    const channelName = `dm-conversation-${conversationId}`
    const subscription = dmSubscriptions.value.get(channelName)
    
    if (subscription) {
      console.log(`🗑️ Cleaning up conversation subscription: ${channelName}`)
      supabase.removeChannel(subscription)
      dmSubscriptions.value.delete(channelName)
    }
  }

  const setupRealtimeSubscriptions = async (userId: string) => {
    try {
      console.log('🔄 Setting up DM realtime subscriptions for user:', userId)
      
      // Subscribe to new conversations - use a unique channel name
      const conversationsChannel = supabase
        .channel(`dm-conversations-${userId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'conversations',
          filter: `or(user1.eq.${userId},user2.eq.${userId})`
        }, (payload) => {
          console.log('🔔 New DM conversation created:', payload)
          fetchUserConversations(userId)
        })
        .subscribe((status) => {
          console.log('📡 DM conversations subscription status:', status)
        })

      // Get reactions store for handling real-time updates
      const reactionsStore = useReactionsStore()

      // Set up GLOBAL DM reactions subscription (similar to chat)
      // This ensures reactions work even when switching between conversations
      const reactionsChannel = supabase
        .channel(`dm-reactions-${userId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'reactions'
        }, async (payload) => {
          console.log('🎯 Global DM reaction INSERT received:', payload)
          reactionsStore.handleRealtimeUpdate(payload)
        })
        .on('postgres_changes', {
          event: 'DELETE',
          schema: 'public',
          table: 'reactions'
        }, async (payload) => {
          console.log('🎯 Global DM reaction DELETE received:', payload)
          reactionsStore.handleRealtimeUpdate(payload)
        })
        .subscribe((status) => {
          console.log('📡 Global DM reactions subscription status:', status)
        })

      // Store the subscriptions
      dmSubscriptions.value.set(`dm-conversations-${userId}`, conversationsChannel)
      dmSubscriptions.value.set(`dm-reactions-${userId}`, reactionsChannel)

    } catch (error) {
      console.error('❌ Error setting up DM realtime subscriptions:', error)
    }
  }

  // Set up subscription for a specific conversation (following useChat pattern)
  const setupConversationSubscription = (conversationId: string) => {
    // Clean up existing subscription for this conversation
    cleanupConversationSubscription(conversationId)

    console.log('🔄 Setting up conversation subscription for:', conversationId)

    const channelName = `dm-conversation-${conversationId}`
    const conversationChannel = supabase
      .channel(channelName)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`  // FIXED: Use correct filter syntax
      }, (payload) => {
        console.log('🔔 New DM message received in DM store:', payload)
        console.log('🔍 Real-time payload details:', {
          event: payload.eventType,
          table: payload.table,
          schema: payload.schema,
          new: payload.new,
          old: payload.old
        });
        
        const message = payload.new as any
        
        const formattedMessage: Message = {
          id: message.id,
          user_id: message.user_id,
          content: message.content,
          created_at: new Date(message.created_at),
          channel_id: '', // Empty string for DMs
          conversation_id: message.conversation_id,
          reply_to: message.reply_to,
          reactions: message.reactions || [],
          is_system: message.is_system
        }
        
        console.log('📨 Adding DM message to cache:', formattedMessage)
        addMessageToCache(formattedMessage)
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`  // FIXED: Use correct filter syntax
      }, async (payload) => {
        console.log('🔄 DM message updated:', payload)
        const message = payload.new as any
        
        // Fetch properly formatted reactions if the message has any
        let formattedReactions = []
        if (message.reactions && message.reactions.length > 0) {
          try {
            const { data: reactions, error: reactionsError } = await supabase
              .rpc('get_message_reactions', { message_id: message.id })
        
            if (!reactionsError && reactions) {
              formattedReactions = reactions
            }
          } catch (error) {
            console.error('Error fetching reactions for updated DM message:', error)
          }
        }
        
        const updatedMessage: Message = {
          id: message.id,
          user_id: message.user_id,
          content: message.content,
          created_at: new Date(message.created_at),
          channel_id: '', // Empty string for DMs
          conversation_id: message.conversation_id,
          reply_to: message.reply_to,
          reactions: formattedReactions,
          is_system: message.is_system
        }
        
        updateMessageInCache(message.id, updatedMessage)
      })
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`  // FIXED: Use correct filter syntax
      }, (payload) => {
        console.log('🗑️ DM message deleted:', payload)
        const messageId = payload.old.id
        removeMessageFromCache(messageId)
      })
      .subscribe((status) => {
        console.log(`📡 DM conversation ${conversationId} subscription status:`, status)
        if (status === 'SUBSCRIBED') {
          console.log(`✅ Successfully subscribed to DM conversation: ${conversationId}`)
          console.log(`📍 Listening for messages on table: messages, filter: conversation_id=eq.${conversationId}`)
        } else if (status === 'CHANNEL_ERROR') {
          console.error(`❌ Error subscribing to DM conversation: ${conversationId}`)
        } else if (status === 'CLOSED') {
          console.log(`🔒 DM conversation subscription closed: ${conversationId}`)
        } else if (status === 'TIMED_OUT') {
          console.warn(`⏰ DM conversation subscription timed out: ${conversationId}`)
        }
      })

    // Store the subscription
    currentSubscription.value = conversationChannel
    dmSubscriptions.value.set(channelName, conversationChannel)
    
    console.log(`📝 Stored DM subscription for ${channelName}, total subscriptions: ${dmSubscriptions.value.size}`)
  }

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
      
      // Only increment unread count if message is not from current user and we're not viewing this conversation
      const currentUser = userDataService.getCurrentUser()
      const currentUserId = currentUser?.id
      
      if (message.user_id !== currentUserId && currentConversationId.value !== message.conversation_id) {
        conversation.unread_count = (conversation.unread_count || 0) + 1
      }
      
      console.log('✅ Updated conversation from new message')
    }
  }

  const cleanup = () => {
    console.log('🧹 Cleaning up DM store')
    
    // Cleanup subscriptions
    cleanupRealtimeSubscriptions()
    
    // Reset state
    conversations.value = []
    currentDMMessages.value = []
    currentConversationId.value = null
    searchResults.value = []
    messageCache.value.clear()
    replyMessageCache.value.clear()
    fetchingReplyMessages.value.clear()
    
    console.log('✅ DM store cleaned up')
  }

  // =================================================================
  // FEDERATION SUPPORT
  // =================================================================
  
  // Process incoming federated DM according to ActivityStreams specification
  const processFederatedDM = async (activity: any, note: any) => {
    try {
      console.log('🌐 Processing federated DM:', { activityId: activity.id, noteId: note.id })
      
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
        console.warn('⚠️ Federated message does not follow direct message mention requirements, may not be a DM')
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
      console.error('❌ Failed to process federated DM:', error)
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
        const url = part.url || `https://${domain}/@${part.username}`
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
          console.warn('Failed to parse recipient URL for mention tag:', recipientUrl, error)
        }
      }
    })
    
    return mentionTags
  }

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
    
    // Computed
    getCurrentConversation,
    getSortedConversations,
    
    // Methods
    isUserOnline,
    isCacheValid,
    loadCachedMessages,
    fetchReplyMessage,
    
    // Actions
    initializeDMEnvironment,
    initializeDMEnvironmentForDirectAccess,
    fetchConversationDetails,
    fetchUserConversations,
    fetchConversationMessages,
    searchUsers,
    createOrGetConversation,
    sendDMMessage,
    setCurrentConversation,
    switchToConversation,
    clearDMMessages,
    setupConversationSubscription,
    cleanupRealtimeSubscriptions,
    cleanup,
    
    // Federation Support
    processFederatedDM,
    validateMentionTag,
    extractMentionsFromMessageParts,
    generateActivityPubMentionTags
  }
})