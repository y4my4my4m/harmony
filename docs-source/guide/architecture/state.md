# State Management with Pinia

Harmony uses Pinia for centralized state management, providing a reactive and type-safe way to manage application state.

## Store Architecture

```mermaid
graph TB
    subgraph "Authentication"
        AUTH_STORE[Auth Store]
    end
    
    subgraph "Communication"
        CHAT_STORE[Chat Store]
        DM_STORE[DM Store]
        VOICE_STORE[Voice Store]
    end
    
    subgraph "Social & Federation"
        ACTIVITYPUB_STORE[ActivityPub Store]
        NOTIFICATION_STORE[Notification Store]
    end
    
    subgraph "Server Management"
        SERVER_STORE[Server Store]
        CHANNEL_STORE[Server Channel Store]
        USERS_STORE[Server Users Store]
    end
    
    subgraph "UI & Preferences"
        THEME_STORE[Theme Store]
        PROFILE_STORE[Profile Store]
        REACTIONS_STORE[Reactions Store]
    end
    
    AUTH_STORE --> CHAT_STORE
    AUTH_STORE --> DM_STORE
    AUTH_STORE --> ACTIVITYPUB_STORE
    SERVER_STORE --> CHANNEL_STORE
    CHANNEL_STORE --> CHAT_STORE
`

## Core Stores

### Authentication Store
Manages user authentication and session state.

```typescript
export const useAuthStore = defineStore('auth', () => {
  const session = ref<Session | null>(null)
  const user = ref<User | null>(null)
  const isAuthenticated = computed(() => !!session.value)
  
  async function login(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    })
    
    if (error) throw error
    
    session.value = data.session
    user.value = data.user
  }
  
  async function logout() {
    await supabase.auth.signOut()
    session.value = null
    user.value = null
  }
  
  return {
    session: readonly(session),
    user: readonly(user),
    isAuthenticated,
    login,
    logout
  }
})
`

### Chat Store
Manages chat messages, channels, and real-time communication.

```typescript
export const useChatStore = defineStore('chat', () => {
  const messages = ref<Map<string, Message[]>>(new Map())
  const currentChannelId = ref<string | null>(null)
  
  const currentMessages = computed(() => {
    if (!currentChannelId.value) return []
    return messages.value.get(currentChannelId.value) || []
  })
  
  function addMessage(channelId: string, message: Message) {
    const channelMessages = messages.value.get(channelId) || []
    channelMessages.push(message)
    messages.value.set(channelId, channelMessages)
  }
  
  async function sendMessage(content: string) {
    if (!currentChannelId.value) return
    
    // Optimistic update
    const tempMessage: Message = {
      id: generateTempId(),
      content,
      status: 'sending',
      // ... other properties
    }
    
    addMessage(currentChannelId.value, tempMessage)
    
    try {
      const result = await services.messages.sendMessage(
        currentChannelId.value,
        content
      )
      
      // Replace temp message with server response
      replaceMessage(currentChannelId.value, tempMessage.id, result)
    } catch (error) {
      // Remove temp message on error
      removeMessage(currentChannelId.value, tempMessage.id)
      throw error
    }
  }
  
  return {
    messages: readonly(messages),
    currentMessages,
    sendMessage,
    addMessage
  }
})
`

## State Persistence

### Local Storage Integration

```typescript
export const useThemeStore = defineStore('theme', () => {
  const currentTheme = ref<Theme>('dark')
  
  // Load from localStorage on initialization
  onMounted(() => {
    const saved = localStorage.getItem('harmony-theme')
    if (saved) {
      currentTheme.value = JSON.parse(saved)
    }
  })
  
  // Save to localStorage when theme changes
  watch(currentTheme, (newTheme) => {
    localStorage.setItem('harmony-theme', JSON.stringify(newTheme))
  }, { deep: true })
  
  return {
    currentTheme,
    setTheme: (theme: Theme) => {
      currentTheme.value = theme
    }
  }
})
`

### Supabase Integration

```typescript
export const useProfileStore = defineStore('profile', () => {
  const profiles = ref<Map<string, UserProfile>>(new Map())
  
  async function fetchProfile(userId: string) {
    if (profiles.value.has(userId)) {
      return profiles.value.get(userId)
    }
    
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    
    if (error) throw error
    
    profiles.value.set(userId, data)
    return data
  }
  
  // Subscribe to profile changes
  supabase
    .channel('profiles')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'profiles'
    }, (payload) => {
      const profile = payload.new as UserProfile
      profiles.value.set(profile.id, profile)
    })
    .subscribe()
  
  return {
    profiles: readonly(profiles),
    fetchProfile
  }
})
`

## Store Composition Patterns

### Composing Multiple Stores

```typescript
export function useServerNavigation() {
  const serverStore = useServerStore()
  const channelStore = useServerChannelStore()
  const chatStore = useChatStore()
  
  async function navigateToChannel(serverId: string, channelId: string) {
    // Update server context
    await serverStore.setCurrentServer(serverId)
    
    // Update channel context
    await channelStore.setCurrentChannel(channelId)
    
    // Load chat messages
    await chatStore.loadMessages(channelId)
  }
  
  return {
    navigateToChannel
  }
}
`

### Store Dependencies

```mermaid
graph TB
    AUTH[Auth Store] --> CHAT[Chat Store]
    AUTH --> DM[DM Store]
    AUTH --> ACTIVITY[ActivityPub Store]
    
    SERVER[Server Store] --> CHANNEL[Channel Store]
    CHANNEL --> CHAT
    
    PROFILE[Profile Store] --> CHAT
    PROFILE --> DM
    
    REACTIONS[Reactions Store] --> CHAT
    EMOJI[Emoji Store] --> REACTIONS
`

## Performance Optimization

### Selective Reactivity

```typescript
export const useChatStore = defineStore('chat', () => {
  const messages = ref<Map<string, Message[]>>(new Map())
  
  // Only reactive for current channel
  const currentMessages = computed(() => {
    const channelId = useServerChannelStore().currentChannelId
    if (!channelId) return []
    return messages.value.get(channelId) || []
  })
  
  // Non-reactive access for bulk operations
  function getAllMessages() {
    return toRaw(messages.value)
  }
  
  return {
    currentMessages,
    getAllMessages
  }
})
`

### Memory Management

```typescript
export const useChatStore = defineStore('chat', () => {
  const messages = ref<Map<string, Message[]>>(new Map())
  const MAX_MESSAGES_PER_CHANNEL = 1000
  
  function addMessage(channelId: string, message: Message) {
    const channelMessages = messages.value.get(channelId) || []
    
    // Limit memory usage
    if (channelMessages.length >= MAX_MESSAGES_PER_CHANNEL) {
      channelMessages.splice(0, 100) // Remove oldest 100 messages
    }
    
    channelMessages.push(message)
    messages.value.set(channelId, channelMessages)
  }
  
  return { addMessage }
})
`

---

> **Next steps:** [Service Layer](./services.md) covers how stores interact with external APIs.