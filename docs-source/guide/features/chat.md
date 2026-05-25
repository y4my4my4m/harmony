# Chat System

The chat system is the core feature of Harmony, providing real-time messaging with support for text, media, reactions, and replies.

## Architecture Overview

```mermaid
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
`

## Message Flow

### Sending Messages

```typescript
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
`

### Real-time Message Reception

```typescript
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
`

## Message Types

### Text Messages

```typescript
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
`

### Media Messages

```typescript
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
`

## Message Features

### Reactions

```typescript
// MessageReactions.vue
async function toggleReaction(messageId: string, emoji: string) {
  const reactionsStore = useReactionsStore()
  
  try {
    await reactionsStore.toggleReaction(messageId, emoji)
  } catch (error) {
    showError('Failed to add reaction')
  }
}
`

### Mentions

```typescript
// Auto-complete mentions
function extractMentions(content: string): string[] {
  const mentionRegex = /@(w+)/g
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
    /@(w+)/g,
    '<span class="mention">@$1</span>'
  )
}
`

### Message Threading

```mermaid
graph TB
    ORIGINAL[Original Message]
    REPLY1[Reply 1]
    REPLY2[Reply 2]
    NESTED_REPLY[Nested Reply]
    
    ORIGINAL --> REPLY1
    ORIGINAL --> REPLY2
    REPLY1 --> NESTED_REPLY
`

## Performance Optimizations

### Virtual Scrolling

```typescript
// MessageDisplay.vue
import { VirtualList } from 'vue-virtual-scroll-list'

const messageItems = computed(() => {
  return messages.value.map(message => ({
    id: message.id,
    height: calculateMessageHeight(message),
    data: message
  }))
})
`

### Message Caching

```typescript
// Chat Store
const messageCache = new Map<string, Message[]>()

function getCachedMessages(channelId: string): Message[] {
  return messageCache.get(channelId) || []
}

function cacheMessages(channelId: string, messages: Message[]) {
  messageCache.set(channelId, messages)
}
`

### Lazy Loading

```typescript
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
`

## Integration with Other Systems

### ActivityPub Federation

```typescript
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
`

### Voice Integration

```typescript
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
`

---

> 📝 **Next Steps**: Learn about [Federation](./federation.md) to understand how chat messages are federated across servers.