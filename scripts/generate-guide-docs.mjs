#!/usr/bin/env node

import { promises as fs } from 'fs'
import path from 'path'

const GUIDE_DIR = 'docs/guide'
const PROTECTED_GUIDE_DIR = 'docs-source/guide'

console.log('🛡️ Creating protected guide documentation...')

// Ensure protected directory exists
await fs.mkdir(PROTECTED_GUIDE_DIR, { recursive: true })
await fs.mkdir(`${PROTECTED_GUIDE_DIR}/architecture`, { recursive: true })
await fs.mkdir(`${PROTECTED_GUIDE_DIR}/features`, { recursive: true })
await fs.mkdir(`${PROTECTED_GUIDE_DIR}/development`, { recursive: true })
await fs.mkdir(`${PROTECTED_GUIDE_DIR}/deployment`, { recursive: true })

// Copy guide documentation from protected source if it exists, otherwise create it
const guideFiles = [
  'index.md',
  'installation.md',
  'configuration.md',
  'environment.md',
  'architecture/index.md',
  'architecture/data-flow.md',
  'architecture/components.md',
  'architecture/state.md',
  'architecture/services.md',
  'features/chat.md',
  'features/social.md',
  'features/federation.md',
  'features/voice.md',
  'features/users.md',
  'features/admin.md',
  'development/index.md',
  'development/testing.md',
  'development/debugging.md',
  'development/performance.md',
  'development/contributing.md',
  'deployment/index.md',
  'deployment/docker.md',
  'deployment/supabase.md',
  'deployment/federation.md',
  'deployment/monitoring.md'
]

for (const file of guideFiles) {
  const protectedPath = path.join(PROTECTED_GUIDE_DIR, file)
  const guidePath = path.join(GUIDE_DIR, file)
  
  try {
    // Check if protected source exists
    const protectedExists = await fs.access(protectedPath).then(() => true).catch(() => false)
    
    if (protectedExists) {
      // Copy from protected source to guide
      const content = await fs.readFile(protectedPath, 'utf-8')
      await fs.mkdir(path.dirname(guidePath), { recursive: true })
      await fs.writeFile(guidePath, content)
      console.log(`  ✅ Copied: ${file}`)
    } else {
      // Create default content in protected source
      const defaultContent = generateDefaultGuideContent(file)
      await fs.mkdir(path.dirname(protectedPath), { recursive: true })
      await fs.writeFile(protectedPath, defaultContent)
      
      // Also copy to guide
      await fs.mkdir(path.dirname(guidePath), { recursive: true })
      await fs.writeFile(guidePath, defaultContent)
      console.log(`  🆕 Created: ${file}`)
    }
  } catch (error) {
    console.error(`  ❌ Error processing ${file}:`, error.message)
  }
}

console.log(`\n✅ Protected guide documentation setup complete!`)
console.log(`📁 Edit guide content in: ${PROTECTED_GUIDE_DIR}`)
console.log(`📁 Published to: ${GUIDE_DIR}`)
console.log(`\n💡 To update guide docs, edit files in ${PROTECTED_GUIDE_DIR} and run this script again.`)

function generateDefaultGuideContent(filePath) {
  const fileName = path.basename(filePath, '.md')
  const section = path.dirname(filePath)
  
  // Generate appropriate content based on file path
  switch (filePath) {
    case 'index.md':
      return generateGuideIndex()
    case 'architecture/index.md':
      return generateArchitectureOverview()
    case 'architecture/data-flow.md':
      return generateDataFlowDocs()
    case 'architecture/state.md':
      return generateStateManagementDocs()
    case 'features/chat.md':
      return generateChatFeatureDocs()
    case 'features/federation.md':
      return generateFederationDocs()
    case 'deployment/index.md':
      return generateDeploymentDocs()
    default:
      return generateGenericGuidePage(fileName, section)
  }
}

function generateGuideIndex() {
  return `# Harmony Developer Guide

Welcome to the Harmony developer guide! This comprehensive documentation will help you understand, develop, and deploy the Harmony federated social platform.

## Quick Start

1. **[Installation](./installation.md)** - Set up your development environment
2. **[Configuration](./configuration.md)** - Configure Harmony for development
3. **[Architecture Overview](./architecture/)** - Understand the system architecture

## Architecture

- **[System Overview](./architecture/)** - High-level architecture and design principles
- **[Data Flow](./architecture/data-flow.md)** - How data flows through the system
- **[Component Structure](./architecture/components.md)** - Vue component organization
- **[State Management](./architecture/state.md)** - Pinia stores and state flow
- **[Service Layer](./architecture/services.md)** - Business logic and API services

## Core Features

- **[Chat System](./features/chat.md)** - Real-time messaging and communication
- **[Social Features](./features/social.md)** - Social media functionality
- **[ActivityPub Federation](./features/federation.md)** - Federation with other platforms
- **[Voice & Video](./features/voice.md)** - Voice chat and video calling
- **[User Management](./features/users.md)** - User accounts and profiles
- **[Administration](./features/admin.md)** - Administrative features

## Development

- **[Development Workflow](./development/)** - Day-to-day development practices
- **[Testing](./development/testing.md)** - Testing strategies and tools
- **[Debugging](./development/debugging.md)** - Debugging techniques
- **[Performance](./development/performance.md)** - Performance optimization
- **[Contributing](./development/contributing.md)** - How to contribute

## Deployment

- **[Production Setup](./deployment/)** - Production deployment guide
- **[Docker](./deployment/docker.md)** - Containerized deployment
- **[Supabase](./deployment/supabase.md)** - Database and backend setup
- **[Federation Setup](./deployment/federation.md)** - Setting up federation
- **[Monitoring](./deployment/monitoring.md)** - Monitoring and observability

---

> 📝 **Note**: This guide is protected from auto-generation. To edit any guide content, modify the files in \`docs-source/guide/\` and run \`npm run docs:generate-guide\`.`
}

function generateArchitectureOverview() {
  return `# System Architecture Overview

Harmony is built using modern web technologies with a focus on performance, scalability, and developer experience.

## Technology Stack

\`\`\`mermaid
graph TB
    subgraph "Frontend"
        VUE[Vue 3 + TypeScript]
        VITE[Vite Build Tool]
        PINIA[Pinia State Management]
        VUE_ROUTER[Vue Router]
    end
    
    subgraph "Backend Services"
        SUPABASE[Supabase]
        EDGE_FUNCTIONS[Edge Functions]
        REALTIME[Realtime Subscriptions]
        AUTH[Authentication]
    end
    
    subgraph "Federation"
        ACTIVITYPUB[ActivityPub Protocol]
        WEBFINGER[WebFinger Discovery]
        HTTP_SIGNATURES[HTTP Signatures]
    end
    
    subgraph "Infrastructure"
        DOCKER[Docker Containers]
        NGINX[Nginx Proxy]
        POSTGRESQL[PostgreSQL Database]
        STORAGE[File Storage]
    end
    
    VUE --> SUPABASE
    EDGE_FUNCTIONS --> ACTIVITYPUB
    SUPABASE --> POSTGRESQL
    DOCKER --> NGINX
    REALTIME --> VUE
    AUTH --> VUE
\`\`\`

## Core Architecture Principles

### 1. Component-Based Architecture
- **Vue 3 Composition API** for reactive components
- **TypeScript** for type safety and better developer experience
- **Scoped styling** with CSS modules and utility classes

### 2. State Management
- **Pinia stores** for centralized state management
- **Reactive data** with Vue's reactivity system
- **Persistent state** for offline functionality

### 3. Real-time Communication
- **Supabase Realtime** for instant message delivery
- **WebRTC** for voice and video communication
- **WebSocket connections** for live updates

### 4. Federation
- **ActivityPub protocol** compliance
- **Decentralized identity** with WebFinger
- **Cross-platform compatibility** with Mastodon, Misskey, etc.

## System Layers

\`\`\`mermaid
graph TB
    subgraph "Presentation Layer"
        COMPONENTS[Vue Components]
        LAYOUTS[Layout Components]
        VIEWS[Page Views]
    end
    
    subgraph "Application Layer"
        COMPOSABLES[Vue Composables]
        STORES[Pinia Stores]
        ROUTER[Vue Router]
    end
    
    subgraph "Service Layer"
        API_SERVICES[API Services]
        UTILS[Utility Functions]
        CONFIG[Configuration]
    end
    
    subgraph "Data Layer"
        SUPABASE_CLIENT[Supabase Client]
        WEBSOCKETS[WebSocket Connections]
        LOCAL_STORAGE[Local Storage]
    end
    
    COMPONENTS --> COMPOSABLES
    COMPOSABLES --> STORES
    STORES --> API_SERVICES
    API_SERVICES --> SUPABASE_CLIENT
    SUPABASE_CLIENT --> WEBSOCKETS
\`

### Presentation Layer
- **Vue Components**: Reusable UI components
- **Layouts**: Page layout templates
- **Views**: Top-level page components

### Application Layer
- **Composables**: Reusable composition functions
- **Stores**: Centralized state management
- **Router**: Client-side routing

### Service Layer
- **API Services**: Business logic and external API calls
- **Utilities**: Helper functions and tools
- **Configuration**: Application configuration

### Data Layer
- **Supabase Client**: Database and real-time connections
- **WebSockets**: Real-time communication
- **Local Storage**: Client-side data persistence

## Key Design Decisions

### TypeScript First
All code is written in TypeScript for:
- **Type Safety**: Catch errors at compile time
- **Better IDE Support**: Enhanced autocomplete and refactoring
- **Self-Documenting Code**: Types serve as documentation

### Composition API
Vue 3's Composition API provides:
- **Better Logic Reuse**: Share logic between components
- **Type Inference**: Better TypeScript integration
- **Performance**: More efficient reactivity

### Modular Architecture
The codebase is organized into modules:
- **Clear Separation**: Each module has a specific responsibility
- **Easy Testing**: Modules can be tested in isolation
- **Scalability**: New features can be added without affecting existing code

---

> 📝 **Next Steps**: Learn about [Data Flow](./data-flow.md) to understand how information moves through the system.`
}

function generateDataFlowDocs() {
  return `# Data Flow Architecture

Understanding how data flows through Harmony is crucial for effective development. This document outlines the data flow patterns used throughout the application.

## Overall Data Flow

\`\`\`mermaid
sequenceDiagram
    participant User
    participant Component
    participant Composable
    participant Store
    participant Service
    participant Supabase
    participant Federation
    
    User->>Component: User Action
    Component->>Composable: Call composable function
    Composable->>Store: Update state
    Store->>Service: Call API service
    Service->>Supabase: Database operation
    Service->>Federation: ActivityPub request
    Supabase-->>Store: Real-time update
    Federation-->>Service: ActivityPub response
    Store-->>Component: Reactive update
    Component-->>User: UI update
\`

## Message Flow Example

Here's how a chat message flows through the system:

\`\`\`mermaid
graph TB
    subgraph "User Input"
        USER_TYPES[User Types Message]
        MESSAGE_INPUT[MessageInput Component]
    end
    
    subgraph "State Management"
        CHAT_STORE[Chat Store]
        USER_STORE[Auth Store]
    end
    
    subgraph "API Layer"
        CHAT_SERVICE[Chat Service]
        USER_SERVICE[User Service]
    end
    
    subgraph "Backend"
        SUPABASE_DB[(Supabase Database)]
        REALTIME[Realtime Subscriptions]
        EDGE_FUNC[Edge Functions]
    end
    
    subgraph "Federation"
        ACTIVITYPUB[ActivityPub]
        REMOTE_SERVERS[Remote Servers]
    end
    
    USER_TYPES --> MESSAGE_INPUT
    MESSAGE_INPUT --> CHAT_STORE
    CHAT_STORE --> CHAT_SERVICE
    CHAT_SERVICE --> SUPABASE_DB
    SUPABASE_DB --> REALTIME
    REALTIME --> CHAT_STORE
    CHAT_SERVICE --> EDGE_FUNC
    EDGE_FUNC --> ACTIVITYPUB
    ACTIVITYPUB --> REMOTE_SERVERS
\`

### Step-by-Step Message Flow

1. **User Input**: User types a message in the MessageInput component
2. **Component Event**: Component emits a 'sendMessage' event
3. **Store Action**: Chat store's sendMessage action is called
4. **Service Call**: Store calls the chat service to send the message
5. **Database Insert**: Service inserts message into Supabase database
6. **Real-time Update**: Supabase sends real-time update to all connected clients
7. **Store Update**: Chat store receives the update and updates local state
8. **Component Reactivity**: MessageDisplay component reactively updates UI
9. **Federation**: Edge function sends ActivityPub activity to federated servers

## State Flow Patterns

### 1. Optimistic Updates

\`\`\`typescript
// Optimistic update pattern
async function sendMessage(content: string) {
  // 1. Immediately add message to local state (optimistic)
  const optimisticMessage = {
    id: generateTempId(),
    content,
    status: 'sending',
    // ... other properties
  }
  
  messages.value.push(optimisticMessage)
  
  try {
    // 2. Send to server
    const result = await chatService.sendMessage(content)
    
    // 3. Replace optimistic message with server response
    const index = messages.value.findIndex(m => m.id === optimisticMessage.id)
    messages.value[index] = result
  } catch (error) {
    // 4. Remove optimistic message on error
    const index = messages.value.findIndex(m => m.id === optimisticMessage.id)
    messages.value.splice(index, 1)
    
    // Show error to user
    showError('Failed to send message')
  }
}
\`

### 2. Real-time Synchronization

\`\`\`typescript
// Real-time sync pattern
export const useChatStore = defineStore('chat', () => {
  const messages = ref<Message[]>([])
  
  // Subscribe to real-time updates
  onMounted(() => {
    supabase
      .channel('messages')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages'
      }, (payload) => {
        // Add new message to local state
        messages.value.push(payload.new as Message)
      })
      .subscribe()
  })
  
  return { messages }
})
\`

### 3. Federated Data Flow

\`\`\`mermaid
sequenceDiagram
    participant Local
    participant EdgeFunc
    participant RemoteServer
    participant RemoteUser
    
    Local->>EdgeFunc: Send ActivityPub Activity
    EdgeFunc->>RemoteServer: POST /inbox
    RemoteServer->>RemoteUser: Deliver Activity
    RemoteUser->>RemoteServer: Create Response
    RemoteServer->>EdgeFunc: POST /inbox
    EdgeFunc->>Local: Store Response
\`

## Error Handling Flow

\`\`\`mermaid
graph TB
    ACTION[User Action]
    SERVICE[Service Call]
    ERROR{Error Occurred?}
    LOCAL_ROLLBACK[Rollback Local State]
    ERROR_STORE[Update Error Store]
    NOTIFICATION[Show User Notification]
    RETRY[Retry Mechanism]
    SUCCESS[Success State]
    
    ACTION --> SERVICE
    SERVICE --> ERROR
    ERROR -->|Yes| LOCAL_ROLLBACK
    LOCAL_ROLLBACK --> ERROR_STORE
    ERROR_STORE --> NOTIFICATION
    NOTIFICATION --> RETRY
    ERROR -->|No| SUCCESS
\`

### Error Handling Patterns

1. **Optimistic Rollback**: If an optimistic update fails, roll back the local state
2. **Error Store**: Centralized error state management
3. **User Feedback**: Always inform the user about errors
4. **Retry Logic**: Automatically retry failed operations where appropriate
5. **Graceful Degradation**: Continue working even when some features fail

## Performance Optimizations

### 1. Lazy Loading
- Components are loaded on-demand
- Store modules are initialized when first used
- Images and media are loaded progressively

### 2. Caching Strategies
- API responses are cached in stores
- Images are cached by the browser
- User preferences are cached in localStorage

### 3. Virtual Scrolling
- Large message lists use virtual scrolling
- Only visible messages are rendered
- Smooth scrolling performance

---

> 📝 **Next Steps**: Learn about [State Management](./state.md) for detailed information about Pinia stores.`
}

function generateStateManagementDocs() {
  return `# State Management with Pinia

Harmony uses Pinia for centralized state management, providing a reactive and type-safe way to manage application state.

## Store Architecture

\`\`\`mermaid
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
\`

## Core Stores

### Authentication Store
Manages user authentication and session state.

\`\`\`typescript
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
\`

### Chat Store
Manages chat messages, channels, and real-time communication.

\`\`\`typescript
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
      const result = await chatService.sendMessage(
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
\`

## State Persistence

### Local Storage Integration

\`\`\`typescript
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
\`

### Supabase Integration

\`\`\`typescript
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
\`

## Store Composition Patterns

### Composing Multiple Stores

\`\`\`typescript
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
\`

### Store Dependencies

\`\`\`mermaid
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
\`

## Performance Optimization

### Selective Reactivity

\`\`\`typescript
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
\`

### Memory Management

\`\`\`typescript
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
\`

---

> 📝 **Next Steps**: Learn about [Service Layer](./services.md) to understand how stores interact with external APIs.`
}

function generateChatFeatureDocs() {
  return `# Chat System

The chat system is the core feature of Harmony, providing real-time messaging with support for text, media, reactions, and replies.

## Architecture Overview

\`\`\`mermaid
graph TB
    subgraph "Chat Components"
        CHAT_COMPONENT[ChatComponent]
        MESSAGE_INPUT[MessageInput]
        MESSAGE_DISPLAY[MessageDisplay]
        MESSAGE_CONTENT[MessageContent]
    end
    
    subgraph "Chat Features"
        REACTIONS[Message Reactions]
        REPLIES[Message Replies]
        MENTIONS[User Mentions]
        MEDIA[Media Upload]
    end
    
    subgraph "Real-time"
        WEBSOCKETS[WebSocket Connection]
        SUPABASE_REALTIME[Supabase Realtime]
        PRESENCE[User Presence]
    end
    
    CHAT_COMPONENT --> MESSAGE_INPUT
    CHAT_COMPONENT --> MESSAGE_DISPLAY
    MESSAGE_DISPLAY --> MESSAGE_CONTENT
    MESSAGE_CONTENT --> REACTIONS
    MESSAGE_CONTENT --> REPLIES
    MESSAGE_INPUT --> MEDIA
    WEBSOCKETS --> SUPABASE_REALTIME
    SUPABASE_REALTIME --> CHAT_COMPONENT
\`

## Message Flow

### Sending Messages

\`\`\`typescript
// MessageInput.vue
async function sendMessage() {
  const chatStore = useChatStore()
  const content = messageText.value.trim()
  
  if (!content) return
  
  try {
    await chatStore.sendMessage(content, {
      replyTo: replyingToMessage.value?.id,
      mentions: extractMentions(content),
      attachments: attachedFiles.value
    })
    
    // Clear input
    messageText.value = ''
    replyingToMessage.value = null
    attachedFiles.value = []
  } catch (error) {
    showError('Failed to send message')
  }
}
\`

### Real-time Message Reception

\`\`\`typescript
// Chat Store
export const useChatStore = defineStore('chat', () => {
  const messages = ref<Map<string, Message[]>>(new Map())
  
  // Subscribe to new messages
  supabase
    .channel('messages')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages'
    }, (payload) => {
      const message = payload.new as Message
      addMessageToChannel(message.channel_id, message)
    })
    .subscribe()
  
  return { messages }
})
\`

## Message Types

### Text Messages

\`\`\`typescript
interface TextMessage {
  id: string
  type: 'text'
  content: string
  author: User
  timestamp: string
  channel_id: string
  reply_to?: string
  mentions: string[]
  reactions: MessageReaction[]
}
\`

### Media Messages

\`\`\`typescript
interface MediaMessage {
  id: string
  type: 'media'
  content: string
  media_attachments: MediaAttachment[]
  author: User
  timestamp: string
  channel_id: string
}

interface MediaAttachment {
  id: string
  type: 'image' | 'video' | 'audio' | 'file'
  url: string
  filename: string
  size: number
  mime_type: string
}
\`

## Message Features

### Reactions

\`\`\`typescript
// MessageReactions.vue
async function toggleReaction(messageId: string, emoji: string) {
  const reactionsStore = useReactionsStore()
  
  try {
    await reactionsStore.toggleReaction(messageId, emoji)
  } catch (error) {
    showError('Failed to add reaction')
  }
}
\`

### Mentions

\`\`\`typescript
// Auto-complete mentions
function extractMentions(content: string): string[] {
  const mentionRegex = /@(\w+)/g
  const mentions: string[] = []
  let match
  
  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push(match[1])
  }
  
  return mentions
}

// Render mentions in messages
function renderContent(content: string): string {
  return content.replace(
    /@(\w+)/g,
    '<span class="mention">@$1</span>'
  )
}
\`

### Message Threading

\`\`\`mermaid
graph TB
    ORIGINAL[Original Message]
    REPLY1[Reply 1]
    REPLY2[Reply 2]
    NESTED_REPLY[Nested Reply]
    
    ORIGINAL --> REPLY1
    ORIGINAL --> REPLY2
    REPLY1 --> NESTED_REPLY
\`

## Performance Optimizations

### Virtual Scrolling

\`\`\`typescript
// MessageDisplay.vue
import { VirtualList } from 'vue-virtual-scroll-list'

const messageItems = computed(() => {
  return messages.value.map(message => ({
    id: message.id,
    height: calculateMessageHeight(message),
    data: message
  }))
})
\`

### Message Caching

\`\`\`typescript
// Chat Store
const messageCache = new Map<string, Message[]>()

function getCachedMessages(channelId: string): Message[] {
  return messageCache.get(channelId) || []
}

function cacheMessages(channelId: string, messages: Message[]) {
  messageCache.set(channelId, messages)
}
\`

### Lazy Loading

\`\`\`typescript
async function loadMoreMessages() {
  const chatStore = useChatStore()
  const oldestMessage = messages.value[0]
  
  if (!oldestMessage) return
  
  const olderMessages = await chatStore.loadMessagesBefore(
    currentChannelId.value!,
    oldestMessage.timestamp
  )
  
  // Prepend to message list
  messages.value.unshift(...olderMessages)
}
\`

## Integration with Other Systems

### ActivityPub Federation

\`\`\`typescript
// When sending a message to a federated channel
async function sendMessage(content: string) {
  // Save to local database
  const message = await chatService.createMessage({
    content,
    channel_id: currentChannelId.value
  })
  
  // Send ActivityPub activity if channel is federated
  if (channel.is_federated) {
    await activityPubService.sendNote({
      content,
      to: channel.federated_followers
    })
  }
  
  return message
}
\`

### Voice Integration

\`\`\`typescript
// Start voice chat from text channel
async function startVoiceChat() {
  const voiceStore = useVoiceStore()
  
  await voiceStore.joinVoiceChannel({
    channelId: currentChannelId.value,
    type: 'voice'
  })
  
  // Show voice UI overlay
  showVoiceOverlay.value = true
}
\`

---

> 📝 **Next Steps**: Learn about [Federation](./federation.md) to understand how chat messages are federated across servers.`
}

function generateFederationDocs() {
  return `# ActivityPub Federation

Harmony implements the ActivityPub protocol to enable federation with other social platforms like Mastodon, Pleroma, and Misskey.

## Federation Architecture

\`\`\`mermaid
graph TB
    subgraph "Harmony Server"
        LOCAL_USER[Local User]
        ACTIVITYPUB_SERVICE[ActivityPub Service]
        EDGE_FUNCTIONS[Supabase Edge Functions]
        DATABASE[(Database)]
    end
    
    subgraph "Remote Servers"
        MASTODON[Mastodon]
        MISSKEY[Misskey]
        PLEROMA[Pleroma]
        OTHER[Other ActivityPub Servers]
    end
    
    LOCAL_USER --> ACTIVITYPUB_SERVICE
    ACTIVITYPUB_SERVICE --> EDGE_FUNCTIONS
    EDGE_FUNCTIONS --> DATABASE
    
    EDGE_FUNCTIONS <--> MASTODON
    EDGE_FUNCTIONS <--> MISSKEY
    EDGE_FUNCTIONS <--> PLEROMA
    EDGE_FUNCTIONS <--> OTHER
\`

## ActivityPub Implementation

### Actor Model

\`\`\`typescript
interface Actor {
  "@context": "https://www.w3.org/ns/activitystreams"
  type: "Person" | "Group" | "Service"
  id: string
  preferredUsername: string
  name: string
  summary: string
  inbox: string
  outbox: string
  followers: string
  following: string
  publicKey: {
    id: string
    owner: string
    publicKeyPem: string
  }
}
\`

### Activity Types

\`\`\`typescript
// Create Activity (for posts/messages)
interface CreateActivity {
  "@context": "https://www.w3.org/ns/activitystreams"
  type: "Create"
  id: string
  actor: string
  object: Note | Article
  to: string[]
  cc: string[]
  published: string
}

// Follow Activity
interface FollowActivity {
  type: "Follow"
  id: string
  actor: string
  object: string
}

// Like Activity (for reactions)
interface LikeActivity {
  type: "Like"
  id: string
  actor: string
  object: string
  content?: string
  "_misskey_reaction"?: string
}
\`

## Message Federation

### Outgoing Messages

\`\`\`typescript
// When a user sends a message to a federated channel
export async function federateMessage(message: Message) {
  const activity: CreateActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Create",
    id: \`\${BASE_URL}/activities/\${message.id}\`,
    actor: \`\${BASE_URL}/users/\${message.author.id}\`,
    object: {
      type: "Note",
      id: \`\${BASE_URL}/notes/\${message.id}\`,
      content: message.content,
      published: message.created_at,
      to: message.visibility === 'public' ? ["https://www.w3.org/ns/activitystreams#Public"] : [],
      cc: await getFollowers(message.author.id)
    },
    to: message.visibility === 'public' ? ["https://www.w3.org/ns/activitystreams#Public"] : [],
    cc: await getFollowers(message.author.id),
    published: message.created_at
  }
  
  // Send to all federated followers
  const followers = await getFederatedFollowers(message.author.id)
  for (const follower of followers) {
    await sendActivity(follower.inbox_url, activity)
  }
}
\`

### Incoming Activities

\`\`\`typescript
// Edge function to handle incoming ActivityPub activities
export async function handleInboxActivity(activity: Activity) {
  switch (activity.type) {
    case 'Create':
      await handleCreateActivity(activity as CreateActivity)
      break
    case 'Follow':
      await handleFollowActivity(activity as FollowActivity)
      break
    case 'Like':
      await handleLikeActivity(activity as LikeActivity)
      break
    case 'Announce':
      await handleAnnounceActivity(activity as AnnounceActivity)
      break
  }
}

async function handleCreateActivity(activity: CreateActivity) {
  const note = activity.object
  
  // Verify the activity signature
  const isValid = await verifySignature(activity)
  if (!isValid) {
    throw new Error('Invalid signature')
  }
  
  // Store the federated message
  await supabase.from('federated_messages').insert({
    activity_id: activity.id,
    content: note.content,
    author_uri: activity.actor,
    published_at: note.published,
    original_json: activity
  })
}
\`

## Reaction Federation

### Misskey Reactions

\`\`\`typescript
// Handle Misskey-style reactions
async function handleMisskeyReaction(activity: LikeActivity) {
  const reaction = activity._misskey_reaction || activity.content || '👍'
  
  await supabase.from('message_reactions').insert({
    message_id: extractMessageId(activity.object),
    user_uri: activity.actor,
    emoji: reaction,
    federated: true
  })
  
  // Notify local users of the reaction
  await sendRealtimeUpdate('reaction_added', {
    messageId: extractMessageId(activity.object),
    reaction: {
      emoji: reaction,
      user_uri: activity.actor
    }
  })
}
\`

### Standard Reactions

\`\`\`typescript
// Send reaction to federated servers
async function federateReaction(messageId: string, emoji: string, userId: string) {
  const activity: LikeActivity = {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      {
        "toot": "http://joinmastodon.org/ns#",
        "_misskey_reaction": "https://misskey-hub.net/ns#_misskey_reaction"
      }
    ],
    type: "Like",
    id: \`\${BASE_URL}/activities/\${generateId()}\`,
    actor: \`\${BASE_URL}/users/\${userId}\`,
    object: \`\${BASE_URL}/messages/\${messageId}\`,
    content: emoji,
    _misskey_reaction: emoji
  }
  
  // Send to servers that might be interested
  const interestedServers = await getInterestedServers(messageId)
  for (const server of interestedServers) {
    await sendActivity(server.inbox_url, activity)
  }
}
\`

## Server Discovery

### WebFinger

\`\`\`typescript
// WebFinger endpoint for user discovery
export async function handleWebFingerRequest(resource: string) {
  const username = extractUsername(resource)
  const user = await getUserByUsername(username)
  
  if (!user) {
    return new Response('Not found', { status: 404 })
  }
  
  return Response.json({
    subject: \`acct:\${username}@\${DOMAIN}\`,
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: \`\${BASE_URL}/users/\${user.id}\`
      }
    ]
  })
}
\`

### Server-to-Server Discovery

\`\`\`typescript
// Discover remote servers through user interactions
async function discoverRemoteServer(actorUri: string) {
  const url = new URL(actorUri)
  const serverDomain = url.hostname
  
  // Check if we already know about this server
  let server = await getKnownServer(serverDomain)
  
  if (!server) {
    // Discover server capabilities
    const nodeInfo = await fetchNodeInfo(serverDomain)
    
    server = await createKnownServer({
      domain: serverDomain,
      software: nodeInfo.software.name,
      version: nodeInfo.software.version,
      capabilities: nodeInfo.protocols
    })
  }
  
  return server
}
\`

## Security & Verification

### HTTP Signatures

\`\`\`typescript
import { verifySignature } from './crypto'

export async function verifyActivitySignature(
  activity: Activity,
  signature: string,
  headers: Headers
): Promise<boolean> {
  const actor = await fetchActor(activity.actor)
  const publicKey = actor.publicKey.publicKeyPem
  
  return verifySignature({
    signature,
    headers,
    publicKey,
    method: 'POST',
    path: '/inbox'
  })
}
\`

### Content Validation

\`\`\`typescript
export function validateActivity(activity: Activity): boolean {
  // Check required fields
  if (!activity.type || !activity.id || !activity.actor) {
    return false
  }
  
  // Validate activity type
  const validTypes = ['Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', 'Like', 'Announce']
  if (!validTypes.includes(activity.type)) {
    return false
  }
  
  // Additional validation based on activity type
  switch (activity.type) {
    case 'Create':
      return validateCreateActivity(activity as CreateActivity)
    case 'Follow':
      return validateFollowActivity(activity as FollowActivity)
    default:
      return true
  }
}
\`

## Federation Settings

### Server Configuration

\`\`\`typescript
interface FederationConfig {
  enabled: boolean
  allowList: string[]  // Allowed servers
  blockList: string[]  // Blocked servers
  autoAcceptFollows: boolean
  publicTimeline: boolean
  mediaProxyEnabled: boolean
}

export const federationConfig: FederationConfig = {
  enabled: true,
  allowList: [], // Empty = allow all
  blockList: ['spam.example'],
  autoAcceptFollows: true,
  publicTimeline: true,
  mediaProxyEnabled: true
}
\`

### User Privacy Controls

\`\`\`typescript
interface UserFederationSettings {
  federationEnabled: boolean
  publicProfile: boolean
  allowMentions: boolean
  allowFollows: boolean
  blockedServers: string[]
}
\`

---

> 📝 **Next Steps**: Learn about [Voice Features](./voice.md) to understand voice chat implementation.`
}

function generateDeploymentDocs() {
  return `# Production Deployment

This guide covers deploying Harmony to production environments with proper security, scalability, and monitoring.

## Deployment Architecture

\`\`\`mermaid
graph TB
    subgraph "Client"
        BROWSER[Web Browser]
        PWA[PWA App]
    end
    
    subgraph "Load Balancer"
        CLOUDFLARE[Cloudflare]
        SSL[SSL Termination]
    end
    
    subgraph "Application Server"
        NGINX[Nginx Proxy]
        HARMONY[Harmony App]
        STATIC[Static Files]
    end
    
    subgraph "Backend Services"
        SUPABASE[Supabase]
        POSTGRES[(PostgreSQL)]
        REALTIME[Realtime Engine]
        EDGE_FUNC[Edge Functions]
    end
    
    subgraph "Storage"
        OBJECT_STORAGE[Object Storage]
        MEDIA_CDN[Media CDN]
    end
    
    BROWSER --> CLOUDFLARE
    PWA --> CLOUDFLARE
    CLOUDFLARE --> SSL
    SSL --> NGINX
    NGINX --> HARMONY
    NGINX --> STATIC
    HARMONY --> SUPABASE
    SUPABASE --> POSTGRES
    SUPABASE --> REALTIME
    SUPABASE --> EDGE_FUNC
    HARMONY --> OBJECT_STORAGE
    OBJECT_STORAGE --> MEDIA_CDN
\`

## Prerequisites

### Domain & DNS Setup

1. **Domain Registration**
   - Register your domain (e.g., \`yourserver.social\`)
   - Set up DNS records pointing to your server

2. **SSL Certificate**
   - Use Let's Encrypt for free SSL certificates
   - Configure automatic renewal

3. **Email Service**
   - Set up SMTP for user registration emails
   - Configure SPF/DKIM records

### Server Requirements

**Minimum Specs:**
- 2 CPU cores
- 4GB RAM
- 50GB SSD storage
- Ubuntu 22.04 LTS or similar

**Recommended Specs:**
- 4+ CPU cores
- 8GB+ RAM
- 100GB+ SSD storage
- Dedicated server or VPS

## Docker Deployment

### Production Docker Compose

\`\`\`yaml
# docker-compose.prod.yml
version: '3.8'

services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
      - ./dist:/usr/share/nginx/html
    depends_on:
      - harmony
    restart: unless-stopped

  harmony:
    build:
      context: .
      dockerfile: Dockerfile.prod
    environment:
      - NODE_ENV=production
      - SUPABASE_URL=\${SUPABASE_URL}
      - SUPABASE_ANON_KEY=\${SUPABASE_ANON_KEY}
      - DOMAIN=\${DOMAIN}
    restart: unless-stopped
    networks:
      - harmony-network

  watchtower:
    image: containrrr/watchtower
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_CLEANUP=true
      - WATCHTOWER_POLL_INTERVAL=3600
    restart: unless-stopped

networks:
  harmony-network:
    driver: bridge
\`

### Production Dockerfile

\`\`\`dockerfile
# Dockerfile.prod
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80 443
CMD ["nginx", "-g", "daemon off;"]
\`

## Environment Configuration

### Production Environment Variables

\`\`\`bash
# .env.production
NODE_ENV=production
DOMAIN=yourserver.social
BASE_URL=https://yourserver.social

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Security
JWT_SECRET=your-very-secure-jwt-secret
ENCRYPTION_KEY=your-32-character-encryption-key

# Federation
FEDERATION_ENABLED=true
ACTIVITYPUB_DOMAIN=yourserver.social

# Media Storage
STORAGE_BACKEND=supabase
MAX_FILE_SIZE=50MB
ALLOWED_FILE_TYPES=image/*,video/*,audio/*

# Email
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=postmaster@mg.yourserver.social
SMTP_PASS=your-smtp-password
FROM_EMAIL=noreply@yourserver.social

# Monitoring
SENTRY_DSN=your-sentry-dsn
LOG_LEVEL=info
\`

## Nginx Configuration

### Production Nginx Config

\`\`\`nginx
# nginx.conf
events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/javascript
        application/json
        application/xml+rss;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=login:10m rate=1r/s;

    server {
        listen 80;
        server_name yourserver.social;
        return 301 https://$server_name$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name yourserver.social;

        # SSL Configuration
        ssl_certificate /etc/nginx/ssl/fullchain.pem;
        ssl_certificate_key /etc/nginx/ssl/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512;
        ssl_prefer_server_ciphers off;

        # Security Headers
        add_header X-Frame-Options DENY;
        add_header X-Content-Type-Options nosniff;
        add_header X-XSS-Protection "1; mode=block";
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";

        # Static files
        location / {
            root /usr/share/nginx/html;
            try_files $uri $uri/ /index.html;
            
            # Cache static assets
            location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
                expires 1y;
                add_header Cache-Control "public, immutable";
            }
        }

        # API proxy
        location /api/ {
            limit_req zone=api burst=20 nodelay;
            proxy_pass http://supabase:3000;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # WebSocket proxy for real-time
        location /realtime/ {
            proxy_pass http://supabase:3000;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host $host;
        }

        # ActivityPub endpoints
        location /.well-known/ {
            limit_req zone=api burst=10 nodelay;
            proxy_pass http://supabase:3000;
            proxy_set_header Host $host;
        }
    }
}
\`

## Database Setup

### Supabase Production Setup

1. **Create Production Project**
   \`\`\`bash
   # Create new Supabase project
   npx supabase projects create harmony-prod --org-id your-org-id
   
   # Link to local development
   npx supabase link --project-ref your-project-ref
   
   # Deploy database schema
   npx supabase db push
   \`\`\`

2. **Configure Database**
   \`\`\`sql
   -- Enable required extensions
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   CREATE EXTENSION IF NOT EXISTS "pgcrypto";
   
   -- Set up Row Level Security
   ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
   ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
   
   -- Create indexes for performance
   CREATE INDEX idx_messages_channel_id ON messages(channel_id);
   CREATE INDEX idx_messages_created_at ON messages(created_at DESC);
   \`\`\`

3. **Database Backup**
   \`\`\`bash
   # Set up automated backups
   npx supabase db dump --file backup.sql
   \`\`\`

## Security Configuration

### SSL/TLS Setup

\`\`\`bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Obtain SSL certificate
sudo certbot --nginx -d yourserver.social

# Auto-renewal
sudo systemctl enable certbot.timer
\`\`\`

### Firewall Configuration

\`\`\`bash
# Configure UFW firewall
sudo ufw enable
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Block common attack patterns
sudo ufw deny from 192.168.0.0/16
sudo ufw deny from 10.0.0.0/8
\`\`\`

### Security Headers

\`\`\`nginx
# Additional security headers
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' wss: https:";
add_header Referrer-Policy "strict-origin-when-cross-origin";
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()";
\`\`\`

## Monitoring & Logging

### Application Monitoring

\`\`\`typescript
// Sentry integration
import * as Sentry from "@sentry/vue"

Sentry.init({
  app,
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
})
\`\`\`

### System Monitoring

\`\`\`yaml
# docker-compose.monitoring.yml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-storage:/var/lib/grafana

volumes:
  grafana-storage:
\`\`\`

### Log Management

\`\`\`bash
# Configure log rotation
sudo nano /etc/logrotate.d/harmony

/var/log/harmony/*.log {
    daily
    missingok
    rotate 52
    compress
    delaycompress
    notifempty
    create 0644 harmony harmony
}
\`\`\`

## Performance Optimization

### Caching Strategy

\`\`\`nginx
# Nginx caching
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=harmony_cache:10m max_size=1g inactive=60m;

location /api/public/ {
    proxy_cache harmony_cache;
    proxy_cache_valid 200 5m;
    proxy_cache_key "$scheme$request_method$host$request_uri";
    add_header X-Cache-Status $upstream_cache_status;
}
\`\`\`

### Database Optimization

\`\`\`sql
-- Optimize database queries
ANALYZE;

-- Monitor slow queries
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Set up connection pooling
ALTER SYSTEM SET max_connections = 100;
ALTER SYSTEM SET shared_buffers = '256MB';
\`\`\`

---

> 📝 **Next Steps**: Learn about [Monitoring](./monitoring.md) for comprehensive monitoring setup.`
}

function generateGenericGuidePage(fileName, section) {
  const title = fileName.charAt(0).toUpperCase() + fileName.slice(1).replace(/-/g, ' ')
  
  return `# ${title}

This is a placeholder page for ${title} documentation.

## Overview

This section covers ${fileName} in the context of ${section}.

## Key Concepts

- Concept 1
- Concept 2
- Concept 3

## Implementation

### Basic Setup

\`\`\`typescript
// Implementation example
export function ${fileName.replace(/-/g, '')}() {
  // Implementation details
}
\`\`\`

### Advanced Configuration

\`\`\`typescript
// Advanced configuration
const config = {
  // Configuration options
}
\`\`\`

## Best Practices

1. Best practice 1
2. Best practice 2
3. Best practice 3

## Troubleshooting

### Common Issues

**Issue 1**
- Problem description
- Solution

**Issue 2**
- Problem description
- Solution

## Examples

### Example 1

\`\`\`typescript
// Example implementation
\`\`\`

### Example 2

\`\`\`typescript
// Another example
\`\`\`

---

> 📝 **Note**: This page is protected from auto-generation. Edit the content in \`docs-source/guide/${section}/${fileName}.md\` and run \`npm run docs:generate-guide\` to update.`
}
