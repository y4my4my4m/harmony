# Data Flow Architecture

Understanding how data flows through Harmony is crucial for effective development. This document outlines the data flow patterns used throughout the application.

## Overall Data Flow

```mermaid
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
`

## Message Flow Example

Here's how a chat message flows through the system:

```mermaid
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
        FED_BACKEND[Federation Backend]
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
    SUPABASE_DB --> FED_BACKEND
    FED_BACKEND --> ACTIVITYPUB
    ACTIVITYPUB --> REMOTE_SERVERS
`

### Step-by-Step Message Flow

1. **User Input**: User types a message in the MessageInput component
2. **Component Event**: Component emits a 'sendMessage' event
3. **Store Action**: Chat store's sendMessage action is called
4. **Service Call**: Store calls the chat service to send the message
5. **Database Insert**: Service inserts message into Supabase database
6. **Real-time Update**: Supabase sends real-time update to all connected clients
7. **Store Update**: Chat store receives the update and updates local state
8. **Component Reactivity**: MessageDisplay component reactively updates UI
9. **Federation**: Database triggers queue federation jobs, delivered by the federation backend

## State Flow Patterns

### 1. Optimistic Updates

```typescript
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
    const result = await services.messages.sendMessage(content)
    
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
`

### 2. Real-time Synchronization

```typescript
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
`

### 3. Federated Data Flow

```mermaid
sequenceDiagram
    participant Local
    participant FedBackend
    participant RemoteServer
    participant RemoteUser
    
    Local->>FedBackend: Queue federation job (via DB trigger)
    FedBackend->>RemoteServer: POST /inbox (signed)
    RemoteServer->>RemoteUser: Deliver Activity
    RemoteUser->>RemoteServer: Create Response
    RemoteServer->>FedBackend: POST /inbox (signed)
    FedBackend->>Local: Store in database
`

## Error Handling Flow

```mermaid
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
`

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

> **Next Steps**: Learn about [State Management](./state.md) for detailed information about Pinia stores.
