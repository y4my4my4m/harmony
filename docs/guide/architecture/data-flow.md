# Data Flow

Understanding how data flows through Harmony is crucial for development and debugging.

## Overview

Harmony follows a unidirectional data flow pattern with reactive state management:

```mermaid
graph TB
    subgraph "Data Flow Architecture"
        USER[User Action] --> COMPONENT[Vue Component]
        COMPONENT --> STORE[Pinia Store]
        STORE --> SERVICE[Service Layer]
        SERVICE --> API[Supabase API]
        API --> DATABASE[(Database)]
        
        DATABASE --> REALTIME[Real-time Engine]
        REALTIME --> SUBSCRIPTION[Subscriptions]
        SUBSCRIPTION --> STORE
        STORE --> COMPONENT
        COMPONENT --> UI[UI Update]
    end
```

## Message Flow

### Chat Message Lifecycle

```mermaid
sequenceDiagram
    participant User
    participant MessageInput
    participant ChatStore
    participant ChatService
    participant Supabase
    participant MessageDisplay
    participant OtherUsers
    
    User->>MessageInput: Type message
    MessageInput->>ChatStore: updateDraft()
    User->>MessageInput: Press Send
    MessageInput->>ChatStore: sendMessage()
    ChatStore->>ChatService: createMessage()
    ChatService->>Supabase: INSERT message
    Supabase->>Supabase: Validate & Store
    Supabase-->>ChatStore: Real-time update
    ChatStore-->>MessageDisplay: New message
    MessageDisplay-->>User: Show message
    Supabase-->>OtherUsers: Broadcast to subscribers
```

### Message State Flow

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Sending: User clicks send
    Sending --> Sent: Success response
    Sending --> Failed: Error response
    Failed --> Draft: User retries
    Sent --> Delivered: Real-time confirmation
    Delivered --> Read: Other users view
    
    state Sent {
        [*] --> Pending
        Pending --> Confirmed: DB write success
    }
```

## Federation Data Flow

### ActivityPub Message Propagation

```mermaid
graph TB
    subgraph "Local Instance"
        POST[Create Post] --> OUTBOX[Actor Outbox]
        OUTBOX --> DELIVERY[Delivery Queue]
    end
    
    subgraph "Remote Instance 1"
        INBOX1[Actor Inbox] --> PROCESS1[Process Activity]
        PROCESS1 --> STORE1[Store Content]
    end
    
    subgraph "Remote Instance 2"
        INBOX2[Actor Inbox] --> PROCESS2[Process Activity]
        PROCESS2 --> STORE2[Store Content]
    end
    
    DELIVERY --> INBOX1
    DELIVERY --> INBOX2
    
    STORE1 --> NOTIFY1[Notify Users]
    STORE2 --> NOTIFY2[Notify Users]
```

### Cross-Instance Communication

```mermaid
sequenceDiagram
    participant LocalUser
    participant LocalInstance
    participant RemoteInstance
    participant RemoteUser
    
    LocalUser->>LocalInstance: Create post
    LocalInstance->>LocalInstance: Store in local DB
    LocalInstance->>LocalInstance: Add to outbox
    LocalInstance->>RemoteInstance: HTTP POST /inbox
    Note over LocalInstance,RemoteInstance: Signed HTTP request
    RemoteInstance->>RemoteInstance: Verify signature
    RemoteInstance->>RemoteInstance: Validate activity
    RemoteInstance->>RemoteInstance: Store activity
    RemoteInstance-->>RemoteUser: Real-time notification
    
    RemoteUser->>RemoteInstance: Like post
    RemoteInstance->>LocalInstance: HTTP POST /inbox (Like activity)
    LocalInstance->>LocalInstance: Process like
    LocalInstance-->>LocalUser: Show like notification
```

## State Management Flow

### Pinia Store Architecture

```mermaid
graph TB
    subgraph "Store Layer"
        AUTH[Auth Store]
        CHAT[Chat Store]
        SERVERS[Server Store]
        DM[DM Store]
        ACTIVITY[ActivityPub Store]
        THEME[Theme Store]
    end
    
    subgraph "Service Layer"
        AUTH_SVC[Auth Service]
        CHAT_SVC[Chat Service]
        USER_SVC[User Service]
        FILE_SVC[File Service]
        AP_SVC[ActivityPub Service]
    end
    
    subgraph "Data Layer"
        SUPABASE[Supabase]
        STORAGE[File Storage]
        REALTIME[Real-time Engine]
    end
    
    AUTH --> AUTH_SVC
    CHAT --> CHAT_SVC
    SERVERS --> USER_SVC
    DM --> CHAT_SVC
    ACTIVITY --> AP_SVC
    
    AUTH_SVC --> SUPABASE
    CHAT_SVC --> SUPABASE
    USER_SVC --> SUPABASE
    FILE_SVC --> STORAGE
    AP_SVC --> SUPABASE
    
    SUPABASE --> REALTIME
    REALTIME --> CHAT
    REALTIME --> ACTIVITY
```

### Store Interaction Patterns

```mermaid
graph LR
    subgraph "Component Level"
        COMP[Vue Component]
        COMPOSABLE[Composable]
    end
    
    subgraph "Store Level"
        STORE[Pinia Store]
        ACTION[Store Action]
        STATE[Reactive State]
    end
    
    subgraph "Service Level"
        SERVICE[Service Function]
        API[API Call]
    end
    
    COMP --> COMPOSABLE
    COMPOSABLE --> STORE
    COMP --> ACTION
    ACTION --> SERVICE
    SERVICE --> API
    API --> STATE
    STATE --> COMP
```

## Real-time Data Synchronization

### Subscription Management

```mermaid
graph TB
    subgraph "Subscription Lifecycle"
        MOUNT[Component Mount] --> SUBSCRIBE[Create Subscription]
        SUBSCRIBE --> LISTEN[Listen for Changes]
        LISTEN --> UPDATE[Update Store]
        UPDATE --> REACTIVE[Reactive UI Update]
        UNMOUNT[Component Unmount] --> CLEANUP[Cleanup Subscription]
    end
    
    subgraph "Supabase Real-time"
        POSTGRES[PostgreSQL] --> TRIGGERS[DB Triggers]
        TRIGGERS --> REALTIME_ENGINE[Real-time Engine]
        REALTIME_ENGINE --> WEBSOCKET[WebSocket]
        WEBSOCKET --> CLIENT[Client Subscription]
    end
    
    LISTEN --> CLIENT
    CLIENT --> UPDATE
```

### Real-time Event Flow

```mermaid
sequenceDiagram
    participant Component
    participant Store
    participant Subscription
    participant Supabase
    participant Database
    
    Component->>Store: Mount & subscribe
    Store->>Subscription: Create channel
    Subscription->>Supabase: WebSocket connection
    
    Note over Database: Data change occurs
    Database->>Supabase: Trigger fires
    Supabase->>Subscription: Real-time event
    Subscription->>Store: Update state
    Store->>Component: Reactive update
```

## File Upload Flow

### File Processing Pipeline

```mermaid
graph TB
    subgraph "Client Side"
        SELECT[File Selection] --> VALIDATE[Client Validation]
        VALIDATE --> PREVIEW[Generate Preview]
        PREVIEW --> UPLOAD[Upload to Storage]
    end
    
    subgraph "Server Side"
        STORAGE[Supabase Storage] --> POLICY[Storage Policies]
        POLICY --> METADATA[Extract Metadata]
        METADATA --> THUMBNAIL[Generate Thumbnails]
        THUMBNAIL --> VIRUS[Virus Scan]
        VIRUS --> RECORD[Database Record]
    end
    
    UPLOAD --> STORAGE
    RECORD --> NOTIFICATION[Notify Upload Complete]
    NOTIFICATION --> CLIENT[Update UI]
```

### Upload State Management

```mermaid
stateDiagram-v2
    [*] --> Selecting
    Selecting --> Validating: File chosen
    Validating --> Invalid: Validation fails
    Validating --> Valid: Validation passes
    Invalid --> Selecting: Choose different file
    Valid --> Uploading: Start upload
    Uploading --> Progress: Upload in progress
    Progress --> Complete: Upload successful
    Progress --> Failed: Upload error
    Failed --> Retrying: User retries
    Retrying --> Uploading: Retry upload
    Complete --> [*]
```

## Error Handling Flow

### Error Propagation

```mermaid
graph TB
    subgraph "Error Sources"
        NETWORK[Network Error]
        VALIDATION[Validation Error]
        AUTH[Auth Error]
        BUSINESS[Business Logic Error]
    end
    
    subgraph "Error Handling"
        CATCH[Error Boundary]
        LOG[Error Logging]
        NOTIFY[User Notification]
        RECOVERY[Recovery Strategy]
    end
    
    subgraph "User Experience"
        TOAST[Toast Message]
        MODAL[Error Modal]
        RETRY[Retry Button]
        FALLBACK[Fallback UI]
    end
    
    NETWORK --> CATCH
    VALIDATION --> CATCH
    AUTH --> CATCH
    BUSINESS --> CATCH
    
    CATCH --> LOG
    CATCH --> NOTIFY
    CATCH --> RECOVERY
    
    NOTIFY --> TOAST
    NOTIFY --> MODAL
    RECOVERY --> RETRY
    RECOVERY --> FALLBACK
```

## Performance Optimization Flow

### Caching Strategy

```mermaid
graph TB
    subgraph "Cache Layers"
        BROWSER[Browser Cache]
        MEMORY[Memory Cache]
        STORAGE[Local Storage]
        CDN[CDN Cache]
    end
    
    subgraph "Cache Flow"
        REQUEST[Data Request] --> CHECK[Check Cache]
        CHECK --> HIT[Cache Hit]
        CHECK --> MISS[Cache Miss]
        HIT --> RETURN[Return Cached Data]
        MISS --> FETCH[Fetch from API]
        FETCH --> CACHE[Update Cache]
        CACHE --> RETURN
    end
    
    REQUEST --> MEMORY
    MEMORY --> STORAGE
    STORAGE --> CDN
    CDN --> FETCH
```

This data flow architecture ensures:
- **Predictable State**: Unidirectional flow makes debugging easier
- **Real-time Updates**: Immediate synchronization across clients
- **Error Resilience**: Robust error handling and recovery
- **Performance**: Efficient caching and optimization
- **Scalability**: Modular architecture supports growth
