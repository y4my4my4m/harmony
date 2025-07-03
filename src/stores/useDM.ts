import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase } from '@/supabase'
import type { Message, MessagePart } from '@/types'

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

  // Actions
  const initializeDMEnvironment = async (userId: string) => {
    try {
      await fetchUserConversations(userId)
      await setupRealtimeSubscriptions(userId)
    } catch (error) {
      console.error('Failed to initialize DM environment:', error)
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
            channel_id: 0, // Not applicable for DMs
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

  const fetchConversationMessages = async (conversationId: string, beforeMessageId?: string) => {
    try {
      loadingMessages.value = true
      
      let query = supabase
        .from('messages')
        .select(`
          id,
          user_id,
          content,
          created_at,
          reactions
        `)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(50)

      if (beforeMessageId) {
        // For pagination - get messages before a specific message
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

      if (error) {
        console.error('Error fetching messages:', error)
        return
      }

      if (!messagesData) return

      const formattedMessages: Message[] = messagesData.map(msg => ({
        id: msg.id,
        user_id: msg.user_id,
        content: msg.content,
        created_at: new Date(msg.created_at),
        conversation_id: conversationId,
        reactions: msg.reactions || []
      }))

      if (beforeMessageId) {
        // Prepend older messages for pagination
        currentDMMessages.value = [...formattedMessages, ...currentDMMessages.value]
      } else {
        // Replace messages for new conversation
        currentDMMessages.value = formattedMessages
      }
      
    } catch (error) {
      console.error('Failed to fetch messages:', error)
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
    content: MessagePart[]
  ): Promise<boolean> => {
    try {
      const { data: newMessage, error } = await supabase
        .from('messages')
        .insert([
          {
            conversation_id: conversationId,
            user_id: userId,
            content: content,
          }
        ])
        .select('*')
        .single()

      if (error) {
        console.error('Error sending message:', error)
        return false
      }

      // Add to current messages if viewing this conversation
      if (currentConversationId.value === conversationId) {
        const formattedMessage: Message = {
          id: newMessage.id,
          user_id: newMessage.user_id,
          content: newMessage.content,
          created_at: new Date(newMessage.created_at),
          channel_id: 0,
          reply_to: newMessage.reply_to,
          reactions: []
        }
        currentDMMessages.value.push(formattedMessage)
      }

      // Update conversation last activity
      const conversation = conversations.value.find(c => c.id === conversationId)
      if (conversation) {
        conversation.last_activity = newMessage.created_at
        conversation.last_message = {
          id: newMessage.id,
          user_id: newMessage.user_id,
          content: newMessage.content,
          created_at: new Date(newMessage.created_at),
          channel_id: 0,
          reactions: []
        }
      }

      return true
    } catch (error) {
      console.error('Failed to send message:', error)
      return false
    }
  }

  const setCurrentConversation = (conversationId: string | null) => {
    currentConversationId.value = conversationId
    
    // Mark conversation as read
    if (conversationId) {
      const conversation = conversations.value.find(c => c.id === conversationId)
      if (conversation) {
        conversation.unread_count = 0
      }
    }
  }

  const clearDMMessages = () => {
    currentDMMessages.value = []
  }

  const setupRealtimeSubscriptions = async (userId: string) => {
    try {
      // Subscribe to new conversations
      supabase
        .channel('conversations')
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'conversations',
          filter: `or(user1.eq.${userId},user2.eq.${userId})`
        }, (payload) => {
          console.log('New conversation:', payload)
          fetchUserConversations(userId)
        })
        .subscribe()

      // Subscribe to new DM messages
      supabase
        .channel('dm_messages')
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: 'conversation_id.not.is.null'
        }, (payload) => {
          console.log('New DM message:', payload)
          const message = payload.new as any
          
          // Update current messages if viewing this conversation
          if (currentConversationId.value === message.conversation_id) {
            const formattedMessage: Message = {
              id: message.id,
              user_id: message.user_id,
              content: message.content,
              created_at: new Date(message.created_at),
              channel_id: 0,
              reply_to: message.reply_to,
              reactions: message.reactions || []
            }
            currentDMMessages.value.push(formattedMessage)
          }

          // Update conversation in sidebar
          const conversation = conversations.value.find(c => c.id === message.conversation_id)
          if (conversation) {
            conversation.last_activity = message.created_at
            conversation.last_message = {
              id: message.id,
              user_id: message.user_id,
              content: message.content,
              created_at: new Date(message.created_at),
              channel_id: 0,
              reactions: []
            }
            if (message.user_id !== userId) {
              conversation.unread_count = (conversation.unread_count || 0) + 1
            }
          }
        })
        .subscribe()

    } catch (error) {
      console.error('Error setting up realtime subscriptions:', error)
    }
  }

  const cleanup = () => {
    // Cleanup subscriptions and reset state
    conversations.value = []
    currentDMMessages.value = []
    currentConversationId.value = null
    searchResults.value = []
    
    // Remove subscriptions
    supabase.removeAllChannels()
    
    console.log('DM store cleaned up')
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
    
    // Computed
    getCurrentConversation,
    getSortedConversations,
    
    // Methods
    isUserOnline,
    
    // Actions
    initializeDMEnvironment,
    fetchUserConversations,
    fetchConversationMessages,
    searchUsers,
    createOrGetConversation,
    sendDMMessage,
    setCurrentConversation,
    clearDMMessages,
    cleanup
  }
})