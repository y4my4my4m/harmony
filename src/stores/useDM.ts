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
  /**
   * Initialize DM environment with configurable loading strategies:
   * - 'lazy': User profiles load only on hover (maximum performance, placeholder UX)
   * - 'partial': Load user profiles for 20 most recent conversations immediately (balanced)
   * - 'immediate': Load ALL user profiles right away (best UX, more database load)
   */
  const initializeDMEnvironment = async (userId: string, forceRefresh = false, metadataOnly = false, loadStrategy: 'lazy' | 'partial' | 'immediate' = 'partial') => {
    // Prevent duplicate initialization
    if (isInitializing.value && !forceRefresh) {
      console.log('🔄 DM initialization already in progress, skipping duplicate')
      return
    }
    
    isInitializing.value = true
    
    try {
      // Clean up any existing subscriptions first
      cleanupRealtimeSubscriptions()
      
      // Only fetch conversations if we don't have them or force refresh is requested
      if (forceRefresh || conversations.value.length === 0) {
        if (metadataOnly) {
          console.log('⚡ Loading DM metadata only (no message content)...')
          await fetchUserConversationsMetadata(userId, loadStrategy)
        } else {
          console.log('📦 Loading full DM conversations...')
          await fetchUserConversations(userId)
        }
      }
      
      // Set up realtime subscriptions (always needed for new messages/updates)
      await setupRealtimeSubscriptions(userId)
    } catch (error) {
      console.error('Failed to initialize DM environment:', error)
    } finally {
      isInitializing.value = false
    }
  }

  // ⚡ OPTIMIZED: Fetch only conversation metadata (no message content, configurable user profile loading)
  // For faster initial load when user isn't actively viewing DMs
  const fetchUserConversationsMetadata = async (userId: string, loadStrategy: 'lazy' | 'partial' | 'immediate' = 'partial') => {
    try {
      console.log('⚡ Fetching DM conversations metadata only...')
      loadingConversations.value = true

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

      if (participationError) {
        console.error('❌ Error fetching conversation metadata:', participationError)
        return
      }

      if (!participations || participations.length === 0) {
        console.log('📝 No conversation metadata found')
        conversations.value = []
        return
      }

      console.log(`📝 Found ${participations.length} conversation metadata entries`)

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
        console.warn('⚠️ Error fetching participant data:', participantError)
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
        console.warn('⚠️ Error fetching last messages for preview:', messagesError)
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
          // OPTIMIZED: No user profile data loaded - just placeholders
          // Real user data will be loaded lazily when conversation is viewed/hovered
          other_user: primaryOtherUserId ? {
            id: primaryOtherUserId,
            username: '', // Will be loaded on demand
            display_name: '', // Will be loaded on demand
            avatar_url: null, // Will be loaded on demand
            is_online: false, // Will be loaded on demand
            // Store that this is placeholder data
            _isPlaceholder: true
          } : undefined
        }

        return dmConversation
      })

      conversations.value = processedConversations
      console.log(`✅ Loaded ${processedConversations.length} conversation metadata entries (${loadStrategy} loading strategy)`)
      
      // OPTIMIZATION: Different loading strategies for user profiles
      if (loadStrategy === 'immediate') {
        // Load ALL user profiles immediately
        const allDirectConversations = processedConversations
          .filter(conv => conv.type === 'direct' && conv.other_user?._isPlaceholder)
          
        if (allDirectConversations.length > 0) {
          // Load all user profiles in background
          setTimeout(() => {
            loadMultipleConversationUserProfiles(allDirectConversations.map(c => c.id))
          }, 100)
        }
      } else if (loadStrategy === 'partial') {
        // Load user profiles for most recent conversations immediately for better UX
        // Keep the rest as lazy-loaded for performance
         const immediateLoadConversations = processedConversations
           .filter(conv => conv.type === 'direct' && conv.other_user?._isPlaceholder)
           .sort((a, b) => new Date(b.last_activity || b.created_at).getTime() - new Date(a.last_activity || a.created_at).getTime()) // Most recent first
           .slice(0, 20) // Load first 20 most recent direct conversations immediately
           
        if (immediateLoadConversations.length > 0) {
          // Load user profiles for recent conversations in background
          setTimeout(() => {
            loadMultipleConversationUserProfiles(immediateLoadConversations.map(c => c.id))
          }, 100)
        }
      } else if (loadStrategy === 'lazy') {
        // Pure lazy loading - everything loads on hover only
        console.log(`⚡ Pure lazy loading - user profiles will load on hover only`)
      }
      
    } catch (error) {
      console.error('❌ Error fetching conversation metadata:', error)
    } finally {
      loadingConversations.value = false
    }
  }

  // Add method to fetch conversation details using participant system
  const fetchConversationDetails = async (conversationId: string, currentUserId: string) => {
    try {
      // First check if we already have this conversation
      const existingConv = conversations.value.find(c => c.id === conversationId)
      if (existingConv) {
        return existingConv
      }

      // Simple approach: Get the specific conversation where user is a participant
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
            is_active
          )
        `)
        .eq('user_id', currentUserId)
        .eq('conversation_id', conversationId)
        .is('left_at', null)
        .single()

      if (participationError || !participation) {
        console.error('❌ Conversation not found or user not participant:', participationError)
        return null
      }

      const conversation = Array.isArray(participation.conversations) 
        ? participation.conversations[0] 
        : participation.conversations

      // Get other participants (excluding current user)
      const { data: otherParticipants, error: othersError } = await supabase
        .from('conversation_participants')
        .select('user_id, role, joined_at')
        .eq('conversation_id', conversationId)
        .neq('user_id', currentUserId)
        .is('left_at', null)

      if (othersError) {
        console.error('Error fetching other participants:', othersError)
      }

      // Get participant count
      const { count: participantCount, error: countError } = await supabase
        .from('conversation_participants')
        .select('*', { count: 'exact', head: true })
        .eq('conversation_id', conversationId)
        .is('left_at', null)

      const convData = {
        conversation_id: conversation.id,
        conversation_name: conversation.name,
        conversation_type: conversation.type || 'direct',
        created_at: conversation.created_at,
        is_active: conversation.is_active,
        participant_count: participantCount ?? 2,
        other_participants: otherParticipants || [],
        user_role: participation.role,
        user_joined_at: participation.joined_at
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

      return processedConv
    } catch (error) {
      console.error('Failed to fetch conversation details:', error)
      return null
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

  // Helper: Service-like method to fetch raw conversation data using participant system
  const _fetchRawConversations = async (userId: string) => {
    try {
      // Simple approach: Query conversations where user is a participant
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
        console.error('Error fetching conversation participations:', participationError)
        return null
      }

      if (!participations || participations.length === 0) {
        return []
      }

      // Transform to the expected format
      const conversationsData = await Promise.all(
        participations.map(async (participation) => {
          const conversation = Array.isArray(participation.conversations) 
            ? participation.conversations[0] 
            : participation.conversations

          // Get other participants (excluding current user)
          const { data: otherParticipants, error: othersError } = await supabase
            .from('conversation_participants')
            .select('user_id, role, joined_at')
            .eq('conversation_id', conversation.id)
            .neq('user_id', userId)
            .is('left_at', null)

          if (othersError) {
            console.error('Error fetching other participants:', othersError)
          }

          // Get participant count
          const { count: participantCount, error: countError } = await supabase
            .from('conversation_participants')
            .select('*', { count: 'exact', head: true })
            .eq('conversation_id', conversation.id)
            .is('left_at', null)

          return {
            conversation_id: conversation.id,
            conversation_name: conversation.name,
            conversation_type: conversation.type || 'direct',
            created_by: conversation.created_by,
            created_at: conversation.created_at,
            is_active: conversation.is_active,
            participant_count: participantCount ?? 2,
            icon_url: conversation.metadata?.icon_url, // Icon stored in metadata
            other_participants: otherParticipants || [],
            user_role: participation.role,
            user_joined_at: participation.joined_at
          }
        })
      )

      return conversationsData
    } catch (error) {
      console.error('Error in _fetchRawConversations:', error)
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
  const _processConversationData = async (conv: any, userId: string): Promise<DMConversation | null> => {
    try {
      console.log('🔍 DEBUG: Processing conversation data:', {
        conversationId: conv.conversation_id,
        type: conv.conversation_type,
        participant_count: conv.participant_count,
        other_participants: conv.other_participants,
        other_participants_length: conv.other_participants?.length,
        conversation_name: conv.conversation_name,
        icon_url: conv.icon_url
      })

      const conversationType = conv.conversation_type || 'direct'
      const participantCount = conv.participant_count || 0
      
      // Get last message for conversation
      const lastMessageData = await _fetchLastMessage(conv.conversation_id)

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
        unread_count: 0, // TODO: Implement proper unread counting
      }

      // Handle different conversation types
      if (conversationType === 'group') {
        // For group conversations, fetch all participants
        const participantProfiles = []
        if (conv.other_participants && Array.isArray(conv.other_participants)) {
          for (const participant of conv.other_participants) {
            const profileData = await _fetchUserProfile(participant.user_id)
            if (profileData) {
              participantProfiles.push(_normalizeUserObject(profileData))
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
          console.log('🔍 DEBUG: Found other participant:', otherUserId)
        }

        if (!otherUserId) {
          console.error('❌ DEBUG: No other participant found for conversation:', conv.conversation_id)
          return null
        }
        
        // Get other user's profile
        const profileData = await _fetchUserProfile(otherUserId)
        if (!profileData) {
          console.error('Failed to fetch profile for user:', otherUserId)
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

  // Helper: Normalize user object to ensure consistent ID field
  const _normalizeUserObject = (user: any): DMUser => {
    // Determine the correct ID (prefer 'id' over 'user_id')
    const userId = user.id || user.user_id
    if (!userId) {
      console.error('User object missing both id and user_id fields:', user)
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
        {
          limit: 20,
          before: beforeTimestamp
        }
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

      // Ensure all messages have conversation_id set
      const formattedMessages: Message[] = orderedMessages.map(msg => ({
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
      
      console.log('🔍 Raw search results from service:', users.map(u => ({ id: u.id, user_id: u.user_id, username: u.username })))
      
      // Normalize and filter users with consistent ID structure
      const filteredUsers = users
        .map(user => _normalizeUserObject(user))
        .filter(user => user.id !== currentUserId)

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
        console.error('Error creating/finding conversation:', error)
        return null
      }

      return conversationId
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
    addMessageToCache(conversationId, optimisticMessage as any);
    
    try {
      console.log('🔄 Sending DM message via MessageService:', { conversationId, userId })
      
      // Use services.messages for consistent DM sending with service layer
      const message = await services.messages.sendDMMessage(
        conversationId,
        content,
        replyTo
      )

      console.log('✅ DM message sent via service layer:', message.id)
      
      // Remove optimistic message
      removeMessageFromCache(conversationId, tempId);
      
      // 🎯 DATABASE TRIGGERS NOW HANDLE:
      // 1. DM notifications (handle_message_notifications trigger)
      // 2. Federation delivery (federate_dm_message trigger)
      // No manual frontend calls needed!

      // Real-time subscription will handle adding to cache via addMessageToCache
      // Don't manually add here to prevent duplicates

      return true
    } catch (error: any) {
      // Remove optimistic message on error
      removeMessageFromCache(conversationId, tempId);
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
      
      // Listen to user profile updates from the centralized cache
      // This ensures DM conversations update when users change their avatars/names
      const { userDataService } = await import('@/services/userDataService')
      userDataService.addEventListener('user-updated', (event: any) => {
        const { userId: updatedUserId } = event.detail
        
        // Update any conversations that have this user
        const updatedConversations = conversations.value.filter(conv => 
          conv.other_user?.id === updatedUserId && !conv.other_user._isPlaceholder
        )
        
        if (updatedConversations.length > 0) {
          // Reload the user profile data for these conversations
          for (const conv of updatedConversations) {
            loadConversationUserProfile(conv.id)
          }
        }
      })
      
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
        const url = part.url || `https://${domain}/users/${part.username}`  // ✅ FIX: Use /users/ format
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

  // Add debugging method
  const debugConversationQueries = async (userId?: string) => {
    const testUserId = userId || '2d06f6ba-4c21-4c84-a963-db65148ac543' // From the logs
    const testConversationId = '06008d5f-7491-47ed-a038-24c323c7d97e' // From user's data
    
    console.log('🧪 MANUAL DEBUG: Testing conversation queries')
    console.log('🧪 Test user ID:', testUserId)
    console.log('🧪 Test conversation ID:', testConversationId)
    
    // Test 1: Check all participants for the conversation
    console.log('\n🧪 Test 1: All participants in conversation')
    const { data: allParticipants, error: allError } = await supabase
      .from('conversation_participants')
      .select('*')
      .eq('conversation_id', testConversationId)
    
    console.log('All participants:', allParticipants, 'Error:', allError)
    
    // Test 2: Check other participants (excluding test user)
    console.log('\n🧪 Test 2: Other participants (excluding current user)')
    const { data: otherParticipants, error: otherError } = await supabase
      .from('conversation_participants')
      .select('user_id, role, joined_at')
      .eq('conversation_id', testConversationId)
      .neq('user_id', testUserId)
      .is('left_at', null)
    
    console.log('Other participants:', otherParticipants, 'Error:', otherError)
    
    // Test 3: Check user's conversations
    console.log('\n🧪 Test 3: User participations')
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
    
    console.log('User conversations:', userConversations, 'Error:', userError)
    
    return {
      allParticipants,
      otherParticipants,
      userConversations
    }
  }

  // Check migration status and provide fix instructions
  const checkMigrationStatus = async () => {
    console.log('🔍 Checking conversation migration status...')
    
    try {
      // Check if conversation_participants table exists
      const { data: participantData, error: participantError } = await supabase
        .from('conversation_participants')
        .select('id')
        .limit(1)
      
      if (participantError) {
        console.error('❌ Migration 013 NOT APPLIED: conversation_participants table missing')
        console.log('💡 To fix this, you need to apply the migration:')
        console.log('   1. Run: psql -d your_database -f db_migrations/013_multi_participant_conversations.sql')
        console.log('   2. Or apply the migration through your Supabase dashboard')
        return { migrationApplied: false, error: participantError }
      }
      
      // Check if conversations table has the new columns
      const { data: convData, error: convError } = await supabase
        .from('conversations')
        .select('id, type, created_by')
        .limit(1)
      
      if (convError) {
        console.error('❌ Migration 013 PARTIALLY APPLIED: conversations table missing new columns')
        console.log('💡 The migration needs to be re-run or completed')
        return { migrationApplied: false, error: convError }
      }
      
      // Check if data was migrated
      const { count: participantCount } = await supabase
        .from('conversation_participants')
        .select('*', { count: 'exact', head: true })
      
      const { count: conversationCount } = await supabase
        .from('conversations')
        .select('*', { count: 'exact', head: true })
      
      console.log('✅ Migration status check:')
      console.log(`   - conversation_participants table: EXISTS (${participantCount} records)`)
      console.log(`   - conversations table: EXISTS (${conversationCount} records)`)
      console.log(`   - Expected participants: ${(conversationCount || 0) * 2}`)
      
      if (participantCount === 0) {
        console.warn('⚠️ Migration tables exist but no participant data found')
        console.log('💡 You may need to re-run the migration data population step')
      }
      
      return { 
        migrationApplied: true, 
        participantCount, 
        conversationCount,
        dataMigrated: participantCount > 0
      }
      
    } catch (error) {
      console.error('❌ Error checking migration status:', error)
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
      console.log('🔄 Creating group conversation:', options)
      
      if (!options.participantIds || options.participantIds.length < 2) {
        console.error('❌ Need at least 2 participants for group conversation')
        return null
      }

      // Get current user for conversation creation
      const currentUserData = userDataService.getCurrentUser()
      if (!currentUserData || !currentUserData.id) {
        console.error('❌ No current user found for conversation creation')
        return null
      }
      
      console.log('✅ Current user for conversation creation:', currentUserData.id)

      // Create the conversation using database function (bypasses RLS)
      const { data: conversationId, error: createError } = await supabase.rpc('create_group_conversation', {
        creator_user_id: currentUserData.id,
        participant_user_ids: options.participantIds,
        conversation_name: options.name || null,
        is_private: options.isPrivate ?? true
      })

      if (createError || !conversationId) {
        console.error('❌ Failed to create conversation:', createError)
        return null
      }

      console.log('✅ Created conversation:', conversationId)

      // Add a system message about conversation creation
      try {
        const systemMessageContent = [{
          type: 'text' as const,
          text: `Group conversation created with ${options.participantIds.length} participants`
        }]

        await services.messages.sendDMMessage(
          conversationId,
          systemMessageContent
        )
      } catch (systemMessageError) {
        console.warn('⚠️ Failed to send system message:', systemMessageError)
        // Don't fail the operation for this
      }

      // Refresh conversations to include the new one
      await fetchUserConversations(currentUserData.id)

      console.log('✅ Successfully created group conversation')
      return conversationId
      
    } catch (error) {
      console.error('❌ Failed to create group conversation:', error)
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
  ): Promise<boolean> => {
    try {
      console.log('🔄 Adding users to conversation:', { conversationId, userIds })
      
      // First, check if this is a direct conversation
      const { data: conversation, error: fetchError } = await supabase
        .from('conversations')
        .select('type, created_by')
        .eq('id', conversationId)
        .single()

      if (fetchError) {
        console.error('❌ Failed to fetch conversation:', fetchError)
        return false
      }

      // If it's a direct conversation, create a NEW group conversation (keep original 1:1 intact)
      if (conversation?.type === 'direct') {
        console.log('🔄 Creating NEW group conversation (preserving original 1:1 chat)')
        
        // Get current participants of the direct conversation
        const { data: currentParticipants, error: participantsError } = await supabase
          .from('conversation_participants')
          .select('user_id')
          .eq('conversation_id', conversationId)

        if (participantsError) {
          console.error('❌ Failed to fetch current participants:', participantsError)
          return false
        }

        if (!currentParticipants || currentParticipants.length === 0) {
          console.error('❌ No current participants found for conversation')
          return false
        }

        // Create new group conversation with all users (current participants + new users)
        const allUserIds = [
          ...currentParticipants.filter(p => p.user_id).map(p => p.user_id),
          ...userIds.filter(id => id) // Filter out any undefined values
        ].filter((id, index, arr) => id && arr.indexOf(id) === index) // Remove duplicates and undefined values

        console.log('🔄 All user IDs for new group:', allUserIds)

        const groupOptions = {
          participantIds: allUserIds,
          name: undefined, // Let the system generate a name
          isPrivate: true // Default to private group
        }

        const newConversationId = await createGroupConversation(groupOptions)
        
        if (newConversationId) {
          // Navigate to the new group conversation
          // The parent component should handle this
          console.log('✅ Created new group conversation:', newConversationId)
          return newConversationId // Return the new conversation ID
        } else {
          return false
        }
      } else {
        // It's already a group conversation, just add the new participants
        console.log('🔄 Adding users to existing group conversation')
        
        // Use the database function to add participants (bypasses RLS)
        for (const userId of userIds) {
          const { error: addError } = await supabase.rpc('add_user_to_conversation', {
            conversation_uuid: conversationId,
            user_uuid: userId,
            user_role: 'member'
          })

          if (addError) {
            console.error('❌ Failed to add participant:', addError)
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
            systemMessageContent
          )
        } catch (systemMessageError) {
          console.warn('⚠️ Failed to send system message:', systemMessageError)
          // Don't fail the operation for this
        }

        // Refresh the conversations to show updated participant count
        await fetchUserConversations(currentUserId)

        console.log('✅ Successfully added users to group conversation')
        return true
      }
      
    } catch (error) {
      console.error('❌ Failed to add users to conversation:', error)
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
      console.error('❌ Failed to get conversation participants:', error)
      return []
    }
  }

  /**
   * Enhanced ActivityPub federation for group DMs
   * Handles private mentions to multiple recipients
   */
  const federateGroupDMMessage = async (
    message: any,
    participants: DMUser[]
  ): Promise<boolean> => {
    try {
      console.log('🌐 Federating group DM message to participants:', participants.length)
      
      // Filter for external (federated) participants
      const externalParticipants = participants.filter(p => !p.is_local)
      
      if (externalParticipants.length === 0) {
        console.log('📝 No external participants, skipping federation')
        return true
      }
      
      // TODO: Implement ActivityPub private group message federation
      // This would involve:
      // 1. Creating a private ActivityPub Note with multiple recipients
      // 2. Setting proper addressing (to: participants, cc: none for privacy)
      // 3. Adding mention tags for all participants
      // 4. Delivering to each external participant's inbox
      // 5. Handling delivery failures and retries
      
      console.warn('🚧 Group DM federation not yet fully implemented')
      return false
      
    } catch (error) {
      console.error('❌ Failed to federate group DM message:', error)
      return false
    }
  }

  // Load user profiles for conversations using centralized cache
  const loadConversationUserProfile = async (conversationId: string): Promise<boolean> => {
    try {
      const conversation = conversations.value.find(c => c.id === conversationId)
      if (!conversation?.other_user?._isPlaceholder) {
        return true // Already loaded or no placeholder
      }

      const { userDataService } = await import('@/services/userDataService')
      
      // Use the centralized cache - this loads from DB if needed, uses cache if available
      const userProfile = await userDataService.fetchUserProfile(conversation.other_user.id)
      
      if (userProfile) {
        // Update conversation with cached user data
        conversation.other_user = {
          id: userProfile.id,
          username: userProfile.username || userProfile.display_name || 'Unknown',
          display_name: userProfile.display_name,
          avatar_url: userProfile.avatar_url,
          is_online: false, // Will be updated by presence if needed
          domain: userProfile.domain,
          is_local: userProfile.is_local,
          federated_id: userProfile.federated_id,
          handle: userProfile.handle || `@${userProfile.username}${userProfile.domain ? '@' + userProfile.domain : ''}`,
          _isPlaceholder: false
        }
        
        return true
      }
      
      return false
    } catch (error) {
      console.error('❌ Failed to load user profile for conversation:', conversationId, error)
      return false
    }
  }

  // Load user profiles for multiple conversations using centralized cache
  const loadMultipleConversationUserProfiles = async (conversationIds: string[]): Promise<void> => {
    try {
      const conversationsToLoad = conversations.value.filter(c => 
        conversationIds.includes(c.id) && c.other_user?._isPlaceholder
      )
      
      if (conversationsToLoad.length === 0) return
      
      const userIds = conversationsToLoad
        .map(c => c.other_user?.id)
        .filter((id): id is string => !!id)
      
      if (userIds.length === 0) return
      
      const { userDataService } = await import('@/services/userDataService')
      
      // Use centralized cache - batch loads missing users, uses cache for existing ones
      const userProfilesMap = await userDataService.fetchMultipleUserProfiles(userIds)
      
      // Update conversations with cached user data
      for (const conversation of conversationsToLoad) {
        const userProfile = conversation.other_user?.id ? userProfilesMap[conversation.other_user.id] : null
        
        if (userProfile && conversation.other_user) {
          conversation.other_user = {
            id: userProfile.id,
            username: userProfile.username || userProfile.display_name || 'Unknown',
            display_name: userProfile.display_name,
            avatar_url: userProfile.avatar_url,
            is_online: false, // Will be updated by presence if needed
            domain: userProfile.domain,
            is_local: userProfile.is_local,
            federated_id: userProfile.federated_id,
            handle: userProfile.handle || `@${userProfile.username}${userProfile.domain ? '@' + userProfile.domain : ''}`,
            _isPlaceholder: false
          }
        }
      }
      
    } catch (error) {
      console.error('❌ Failed to batch load user profiles:', error)
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
    fetchUserConversationsMetadata,
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
    checkMigrationStatus
  }
})