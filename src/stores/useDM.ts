import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
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

export interface DMMessage {
  id: string
  conversation_id: string
  user_id: string
  content: MessagePart[]
  created_at: string
  updated_at?: string
  reply_to?: string
  is_edited?: boolean
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

  // Actions
  const initializeDMEnvironment = async (userId: string) => {
    try {
      await fetchUserConversations(userId)
      setupRealtimeSubscriptions(userId)
    } catch (error) {
      console.error('Failed to initialize DM environment:', error)
    }
  }

  const fetchUserConversations = async (userId: string) => {
    try {
      loadingConversations.value = true
      
      // Mock data for development - replace with actual Supabase query
      const mockConversations: DMConversation[] = [
        {
          id: 'conv-1',
          user1_id: userId,
          user2_id: 'user-2',
          created_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
          last_activity: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
          unread_count: 2,
          other_user: {
            id: 'user-2',
            username: 'alice_dev',
            display_name: 'Alice Developer',
            avatar_url: undefined,
            is_online: true
          }
        },
        {
          id: 'conv-2',
          user1_id: userId,
          user2_id: 'user-3',
          created_at: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
          last_activity: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
          unread_count: 0,
          other_user: {
            id: 'user-3',
            username: 'bob_designer',
            display_name: 'Bob Designer',
            avatar_url: undefined,
            is_online: false,
            last_seen: new Date(Date.now() - 3600000).toISOString()
          }
        }
      ]
      
      conversations.value = mockConversations
      
    } catch (error) {
      console.error('Failed to fetch conversations:', error)
    } finally {
      loadingConversations.value = false
    }
  }

  const fetchConversationMessages = async (conversationId: string) => {
    try {
      loadingMessages.value = true
      
      // Mock messages for development - convert to proper Message type
      const mockMessages: Message[] = [
        {
          id: 'msg-1',
          user_id: 'user-2',
          content: [{ type: 'text', text: 'Hey there! How are you doing?' }],
          created_at: new Date(Date.now() - 3600000),
          channel_id: parseInt(conversationId.replace(/\D/g, '')) || 1, // Convert string to number
          reply_to: undefined,
          reactions: []
        },
        {
          id: 'msg-2',
          user_id: 'current-user',
          content: [{ type: 'text', text: 'Hi Alice! I\'m doing great, thanks for asking. How about you?' }],
          created_at: new Date(Date.now() - 3500000),
          channel_id: parseInt(conversationId.replace(/\D/g, '')) || 1,
          reply_to: undefined,
          reactions: []
        },
        {
          id: 'msg-3',
          user_id: 'user-2',
          content: [{ type: 'text', text: 'I\'m doing well! Working on some exciting new features. Want to see a preview?' }],
          created_at: new Date(Date.now() - 3400000),
          channel_id: parseInt(conversationId.replace(/\D/g, '')) || 1,
          reply_to: 'msg-2',
          reactions: []
        }
      ]
      
      currentDMMessages.value = mockMessages
      
    } catch (error) {
      console.error('Failed to fetch messages:', error)
    } finally {
      loadingMessages.value = false
    }
  }

  const searchUsers = async (query: string) => {
    try {
      isSearching.value = true
      
      // Mock search results
      const mockUsers: DMUser[] = [
        {
          id: 'user-4',
          username: 'charlie_dev',
          display_name: 'Charlie Developer',
          avatar_url: undefined,
          is_online: true
        },
        {
          id: 'user-5',
          username: 'diana_designer',
          display_name: 'Diana Designer',
          avatar_url: undefined,
          is_online: false
        }
      ].filter(user => 
        user.username.toLowerCase().includes(query.toLowerCase()) ||
        user.display_name?.toLowerCase().includes(query.toLowerCase())
      )
      
      searchResults.value = mockUsers
      
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
      const existingConv = conversations.value.find(conv => 
        (conv.user1_id === user1Id && conv.user2_id === user2Id) ||
        (conv.user1_id === user2Id && conv.user2_id === user1Id)
      )
      
      if (existingConv) {
        return existingConv.id
      }
      
      // Create new conversation
      const newConversationId = `conv-${Date.now()}`
      const newConversation: DMConversation = {
        id: newConversationId,
        user1_id: user1Id,
        user2_id: user2Id,
        created_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
        unread_count: 0,
        other_user: {
          id: user2Id,
          username: `user_${user2Id.slice(0, 8)}`,
          display_name: undefined,
          avatar_url: undefined,
          is_online: false
        }
      }
      
      conversations.value.unshift(newConversation)
      
      return newConversationId
    } catch (error) {
      console.error('Failed to create conversation:', error)
      return null
    }
  }

  const sendDMMessage = async (
    conversationId: string,
    userId: string,
    content: MessagePart[],
    replyToId?: string
  ): Promise<boolean> => {
    try {
      const messageId = `msg-${Date.now()}`
      const newMessage: Message = {
        id: messageId,
        user_id: userId,
        content,
        created_at: new Date(),
        channel_id: parseInt(conversationId.replace(/\D/g, '')) || 1,
        reply_to: replyToId,
        reactions: []
      }
      
      // Add to current messages if viewing this conversation
      if (currentConversationId.value === conversationId) {
        currentDMMessages.value.push(newMessage)
      }
      
      // Update conversation last activity
      const conversation = conversations.value.find(c => c.id === conversationId)
      if (conversation) {
        conversation.last_activity = new Date().toISOString()
        conversation.last_message = newMessage
      }
      
      return true
    } catch (error) {
      console.error('Failed to send message:', error)
      return false
    }
  }

  const setCurrentConversation = (conversationId: string) => {
    currentConversationId.value = conversationId
    
    // Mark conversation as read
    const conversation = conversations.value.find(c => c.id === conversationId)
    if (conversation) {
      conversation.unread_count = 0
    }
  }

  const clearDMMessages = () => {
    currentDMMessages.value = []
  }

  const setupRealtimeSubscriptions = (_userId: string) => {
    // Mock realtime updates
    console.log('Setting up realtime subscriptions for DMs')
  }

  const cleanup = () => {
    // Cleanup subscriptions and reset state
    conversations.value = []
    currentDMMessages.value = []
    currentConversationId.value = null
    searchResults.value = []
    
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