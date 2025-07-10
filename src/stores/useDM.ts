import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase } from '@/supabase'
import type { Message, MessagePart } from '@/types'
import { useServerUsersStore } from './useServerUsers'
import { useAuthStore } from './auth'

// Types for DM functionality
export interface DMUser {
  id: string
  username: string
  display_name?: string
  avatar_url?: string
  is_online?: boolean
  last_seen?: string
}

export interface DMConversation {
  id: string
  user1_id: string
  user2_id: string
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

  // Check if user is online (mock for now, can be enhanced with presence)
  const isUserOnline = (userId: string): boolean => {
    const user = searchResults.value.find(u => u.id === userId)
    return user?.is_online || false
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
      const { data: message, error } = await supabase
        .from('messages')
        .select('*')
        .eq('id', messageId)
        .single()

      if (error || !message) {
        console.error('Error fetching DM reply message:', error)
        return null
      }

      // Fetch reactions for the message if it has any
      if (message.reactions && message.reactions.length > 0) {
        const { data: reactions, error: reactionsError } = await supabase
          .rpc('get_message_reactions', { message_id: message.id })
    
        if (!reactionsError) {
          message.reactions = reactions
        }
      }

      // Cache the message
      replyMessageCache.value.set(messageId, message)
      return message
    } catch (error) {
      console.error('Error fetching DM reply message:', error)
      return null
    } finally {
      fetchingReplyMessages.value.delete(messageId)
    }
  }

  // Actions
  const initializeDMEnvironment = async (userId: string) => {
    try {
      // Clean up any existing subscriptions first
      cleanupRealtimeSubscriptions()
      
      await fetchUserConversations(userId)
      await setupRealtimeSubscriptions(userId)
    } catch (error) {
      console.error('Failed to initialize DM environment:', error)
    }
  }

  // Add method to fetch conversation details and ensure user profiles are loaded
  const fetchConversationDetails = async (conversationId: string, currentUserId: string) => {
    try {
      // First check if we already have this conversation
      const existingConv = conversations.value.find(c => c.id === conversationId)
      if (existingConv) {
        return existingConv
      }

      // Fetch the specific conversation
      const { data: convData, error: convError } = await supabase
        .from('conversations')
        .select('id, user1, user2, created_at')
        .eq('id', conversationId)
        .single()

      if (convError || !convData) {
        console.error('Error fetching conversation:', convError)
        return null
      }

      // Determine the other user
      const otherUserId = convData.user1 === currentUserId ? convData.user2 : convData.user1
      
      // Get user profiles for both users and ensure they're in the server users store
      const serverUsersStore = useServerUsersStore()
      await serverUsersStore.fetchUserProfiles([currentUserId, otherUserId])

      // Get other user's profile for the conversation
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .eq('id', otherUserId)
        .single()

      if (profileError) {
        console.error('Error fetching profile:', profileError)
        return null
      }

      // Get last message for conversation
      const { data: lastMessageData } = await supabase
        .from('messages')
        .select('id, user_id, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      const processedConv: DMConversation = {
        id: convData.id,
        user1_id: convData.user1,
        user2_id: convData.user2,
        created_at: convData.created_at,
        last_activity: lastMessageData?.created_at || convData.created_at,
        last_message: lastMessageData ? {
          id: lastMessageData.id,
          user_id: lastMessageData.user_id,
          content: lastMessageData.content,
          created_at: new Date(lastMessageData.created_at),
          channel_id: '', // Empty string for DMs
          conversation_id: conversationId,
          reactions: []
        } : undefined,
        unread_count: 0,
        other_user: {
          id: profileData.id,
          username: profileData.username,
          display_name: profileData.display_name,
          avatar_url: profileData.avatar_url,
          is_online: false
        }
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

  // Enhanced initialization for direct DM access
  const initializeDMEnvironmentForDirectAccess = async (userId: string, conversationId?: string) => {
    try {
      // Always initialize basic DM environment
      await initializeDMEnvironment(userId)
      
      // If we have a specific conversation ID, ensure it's loaded
      if (conversationId) {
        const conversation = await fetchConversationDetails(conversationId, userId)
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
      
      // Fetch conversations where user is participant
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
        return
      }

      if (!conversationsData) return

      // Get all unique user IDs to ensure profiles are loaded
      const allUserIds = new Set<string>()
      conversationsData.forEach(conv => {
        allUserIds.add(conv.user1)
        allUserIds.add(conv.user2)
      })

      // Ensure all user profiles are loaded in the server users store
      const serverUsersStore = useServerUsersStore()
      await serverUsersStore.fetchUserProfiles(Array.from(allUserIds))

      // Process conversations and get other user details
      const processedConversations: DMConversation[] = []
      
      for (const conv of conversationsData) {
        const otherUserId = conv.user1 === userId ? conv.user2 : conv.user1
        
        // Get other user's profile
        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url')
          .eq('id', otherUserId)
          .single()

        if (profileError) {
          console.error('Error fetching profile:', profileError)
          continue
        }

        // Get last message for conversation
        const { data: lastMessageData } = await supabase
          .from('messages')
          .select('id, user_id, content, created_at')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single()

        // Count unread messages (messages after user's last read)
        const unreadCount = 0 // TODO: Implement proper unread counting

        const processedConv: DMConversation = {
          id: conv.id,
          user1_id: conv.user1,
          user2_id: conv.user2,
          created_at: conv.created_at,
          last_activity: lastMessageData?.created_at || conv.created_at,
          last_message: lastMessageData ? {
            id: lastMessageData.id,
            user_id: lastMessageData.user_id,
            content: lastMessageData.content,
            created_at: new Date(lastMessageData.created_at),
            channel_id: '', // Empty string for DMs
            conversation_id: conv.id,
            reactions: []
          } : undefined,
          unread_count: unreadCount,
          other_user: {
            id: profileData.id,
            username: profileData.username,
            display_name: profileData.display_name,
            avatar_url: profileData.avatar_url,
            is_online: false // TODO: Implement presence
          }
        }

        processedConversations.push(processedConv)
      }
      
      conversations.value = processedConversations
      
    } catch (error) {
      console.error('Failed to fetch conversations:', error)
    } finally {
      loadingConversations.value = false
    }
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
      let query = supabase
        .from('messages')
        .select(`*`)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(20)

      if (beforeMessageId) {
        const { data: beforeMessage } = await supabase
          .from('messages')
          .select('created_at')
          .eq('id', beforeMessageId)
          .single()
        
        if (beforeMessage) {
          query = query.lt('created_at', beforeMessage.created_at)
        }
      }

      const { data: messagesData, error } = await query

      // Check if request was cancelled
      if (signal?.aborted) {
        throw new Error('Request aborted')
      }

      if (error) {
        console.error('Error fetching DM messages:', error)
        return
      }

      if (!messagesData) return

      // Fetch reactions for messages
      for (const message of messagesData) {
        if (message.reactions && message.reactions.length > 0) {
          const { data: reactions, error: reactionsError } = await supabase
            .rpc('get_message_reactions', { message_id: message.id })
      
          if (reactionsError) {
            console.error('Error fetching reactions:', reactionsError)
            continue
          }
      
          message.reactions = reactions
        }
      }

      const reversedMessages = messagesData.reverse()
      const allLoaded = messagesData.length < 20

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
      
      if (!query.trim()) {
        searchResults.value = []
        return
      }

      const { data: users, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .neq('id', currentUserId) // Exclude current user
        .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
        .limit(10)

      if (error) {
        console.error('Error searching users:', error)
        searchResults.value = []
        return
      }

      searchResults.value = (users || []).map(user => ({
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        is_online: false // TODO: Implement presence
      }))
      
    } catch (error) {
      console.error('Failed to search users:', error)
      searchResults.value = []
    } finally {
      isSearching.value = false
    }
  }

  const createOrGetConversation = async (user1Id: string, user2Id: string): Promise<string | null> => {
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

      // Refresh conversations to include the new one
      await fetchUserConversations(user1Id)

      return newConv.id
    } catch (error) {
      console.error('Failed to create conversation:', error)
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
      console.log('🔄 Sending DM message:', { conversationId, userId, content })
      
      const { data: newMessage, error } = await supabase
        .from('messages')
        .insert([
          {
            conversation_id: conversationId,
            user_id: userId,
            content: content,
            ...(replyTo ? { reply_to: replyTo } : {})
          }
        ])
        .select('*')
        .single()

      if (error) {
        console.error('❌ Database error sending DM message:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code
        })
        return false
      }

      console.log('✅ DM message sent successfully to database:', newMessage)
      
      // 🔔 Database triggers now handle DM notifications automatically
      // No need for manual notification creation - the database trigger will detect
      // the new message insert and create appropriate notifications based on conversation participants

      // Real-time subscription will handle adding to cache via addMessageToCache
      // Don't manually add here to prevent duplicates

      return true
    } catch (error) {
      console.error('❌ Failed to send DM message:', error)
      return false
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

      dmSubscriptions.value.set(`dm-conversations-${userId}`, conversationsChannel)

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
      const authStore = useAuthStore()
      const currentUserId = authStore.session?.user?.id
      
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
    clearDMMessages,
    setupConversationSubscription,
    cleanupRealtimeSubscriptions,
    cleanup
  }
})