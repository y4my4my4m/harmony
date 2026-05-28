# System Flow Documentation

## Overview

This document provides a comprehensive view of how data flows through the Harmony system, from user interactions to database updates, real-time synchronization, and federation with external services.

## Core Application Flows

### 1. User Authentication Flow

```mermaid
sequenceDiagram
    participant User
    participant App
    participant AuthStore
    participant Supabase
    participant ProfileStore
    participant ServerStore

    User->>App: Login Request
    App->>AuthStore: login(email, password)
    AuthStore->>Supabase: auth.signInWithPassword()
    
    alt Success
        Supabase-->>AuthStore: Session + User
        AuthStore->>AuthStore: setSession()
        AuthStore->>ProfileStore: fetchProfileByAuthUserId()
        ProfileStore->>Supabase: Query profiles table
        Supabase-->>ProfileStore: User profile data
        ProfileStore->>ServerStore: initializeUserEnvironment()
        ServerStore->>Supabase: Query user servers
        Supabase-->>ServerStore: Server list
        ServerStore-->>App: Environment ready
        App-->>User: Authenticated + Redirected
    else Error
        Supabase-->>AuthStore: Error
        AuthStore-->>App: Login failed
        App-->>User: Error message
    end
```

### 2. Message Sending Flow

```mermaid
sequenceDiagram
    participant User
    participant ChatComponent
    participant ChatStore
    participant ContentProcessor
    participant Supabase
    participant RealtimeChannel
    participant RemoteUsers

    User->>ChatComponent: Type & Send Message
    ChatComponent->>ChatStore: sendMessage(content)
    ChatStore->>ContentProcessor: processContent(message)
    
    Note over ContentProcessor: Process mentions, emojis, links
    
    ContentProcessor-->>ChatStore: Processed content
    ChatStore->>Supabase: Insert message
    
    Note over Supabase: Row Level Security Check
    
    Supabase-->>ChatStore: Message created
    ChatStore->>ChatStore: addMessage(localState)
    ChatStore->>RealtimeChannel: Broadcast via Supabase Realtime
    
    RealtimeChannel-->>RemoteUsers: Real-time message delivery
    RemoteUsers->>RemoteUsers: Update UI
    
    ChatStore-->>ChatComponent: Update sent
    ChatComponent-->>User: Message visible
```

### 3. Voice Channel Connection Flow

```mermaid
sequenceDiagram
    participant User
    participant VoiceComponent
    participant VoiceStore
    participant WebRTCService
    participant SupabaseRealtime
    participant SpatialAudioService
    participant RemotePeers

    User->>VoiceComponent: Click Connect
    VoiceComponent->>VoiceStore: connectToVoiceChannel(channelId)
    VoiceStore->>WebRTCService: initializeConnection()
    
    WebRTCService->>WebRTCService: getUserMedia()
    WebRTCService->>SupabaseRealtime: Join voice channel room
    
    SupabaseRealtime-->>WebRTCService: Room joined
    WebRTCService->>RemotePeers: Exchange ICE candidates
    
    RemotePeers-->>WebRTCService: Peer connections established
    
    opt Spatial Audio Enabled
        WebRTCService->>SpatialAudioService: initializeSpatialAudio()
        SpatialAudioService->>SpatialAudioService: Create audio context
        SpatialAudioService-->>VoiceStore: Spatial audio ready
    end
    
    WebRTCService-->>VoiceStore: Connection established
    VoiceStore-->>VoiceComponent: Connected state
    VoiceComponent-->>User: Voice channel active
```

### 4. Federation Activity Flow

```mermaid
sequenceDiagram
    participant HarmonyUser
    participant ActivityPubStore
    participant FederationService
    participant EdgeFunction
    participant RemoteInstance
    participant RemoteUser

    HarmonyUser->>ActivityPubStore: Create federated post
    ActivityPubStore->>FederationService: createPost(content)
    FederationService->>EdgeFunction: POST /api/activities
    
    Note over EdgeFunction: Generate ActivityPub activity
    
    EdgeFunction->>EdgeFunction: Sign HTTP request
    EdgeFunction->>RemoteInstance: POST /inbox (ActivityPub)
    
    RemoteInstance->>RemoteInstance: Verify signature
    RemoteInstance->>RemoteInstance: Process Create activity
    RemoteInstance-->>EdgeFunction: 202 Accepted
    
    EdgeFunction-->>FederationService: Delivery confirmed
    FederationService-->>ActivityPubStore: Post federated
    
    RemoteInstance->>RemoteUser: Show federated post
    
    opt User Interaction (Like/Reply)
        RemoteUser->>RemoteInstance: Interact with post
        RemoteInstance->>EdgeFunction: POST /inbox (Like/Reply)
        EdgeFunction->>ActivityPubStore: Process interaction
        ActivityPubStore-->>HarmonyUser: Notification
    end
```

## Data Architecture Flow

### Database Interaction Pattern

```mermaid
graph TB
    subgraph "Client Layer"
        COMP[Vue Components]
        STORE[Pinia Stores]
        COMP_CACHE[Composable Cache]
    end
    
    subgraph "Service Layer"
        SERVICE[Business Services]
        CACHE[Cache Manager]
        VALIDATOR[Input Validator]
    end
    
    subgraph "Data Layer"
        SUPABASE[Supabase Client]
        RLS[Row Level Security]
        POSTGRES[PostgreSQL]
        REALTIME[Realtime Engine]
    end
    
    subgraph "Storage Layer"
        BUCKET[Storage Buckets]
        CDN[CDN Delivery]
        FILES[File System]
    end
    
    COMP --> STORE
    STORE --> COMP_CACHE
    STORE --> SERVICE
    SERVICE --> CACHE
    SERVICE --> VALIDATOR
    VALIDATOR --> SUPABASE
    SUPABASE --> RLS
    RLS --> POSTGRES
    SUPABASE --> REALTIME
    SUPABASE --> BUCKET
    BUCKET --> CDN
    CDN --> FILES
    
    REALTIME --> SUPABASE
    POSTGRES --> SUPABASE
```

### Real-time Data Synchronization

```mermaid
graph LR
    subgraph "Client A"
        STORE_A[Pinia Store A]
        COMP_A[Components A]
    end
    
    subgraph "Client B"
        STORE_B[Pinia Store B]
        COMP_B[Components B]
    end
    
    subgraph "Supabase Backend"
        POSTGRES_DB[(PostgreSQL)]
        REALTIME_ENGINE[Realtime Engine]
        WEBSOCKET[WebSocket Server]
    end
    
    STORE_A --> POSTGRES_DB
    POSTGRES_DB --> REALTIME_ENGINE
    REALTIME_ENGINE --> WEBSOCKET
    WEBSOCKET --> STORE_A
    WEBSOCKET --> STORE_B
    STORE_B --> COMP_B
    STORE_A --> COMP_A
    
    POSTGRES_DB --> STORE_B
```

## Component Communication Patterns

### Parent-Child Communication

```mermaid
graph TD
    PARENT[Parent Component]
    CHILD1[Child Component 1]
    CHILD2[Child Component 2]
    
    PARENT -->|Props| CHILD1
    PARENT -->|Props| CHILD2
    CHILD1 -->|Events| PARENT
    CHILD2 -->|Events| PARENT
    
    PARENT -.->|Provide| INJECTION[Dependency Injection]
    CHILD1 -.->|Inject| INJECTION
    CHILD2 -.->|Inject| INJECTION
```

### Store-Mediated Communication

```mermaid
graph TB
    subgraph "Components"
        COMP1[Chat Component]
        COMP2[Sidebar Component]
        COMP3[Voice Component]
    end
    
    subgraph "Stores"
        CHAT_STORE[Chat Store]
        USER_STORE[User Store]
        VOICE_STORE[Voice Store]
    end
    
    subgraph "Services"
        CHAT_SVC[Chat Service]
        PRESENCE_SVC[Presence Service]
        VOICE_SVC[Voice Service]
    end
    
    COMP1 <--> CHAT_STORE
    COMP2 <--> USER_STORE
    COMP3 <--> VOICE_STORE
    
    CHAT_STORE <--> CHAT_SVC
    USER_STORE <--> PRESENCE_SVC
    VOICE_STORE <--> VOICE_SVC
    
    CHAT_STORE -.-> USER_STORE
    VOICE_STORE -.-> USER_STORE
```

## PWA and Desktop App Flow

### Service Worker Integration

```mermaid
sequenceDiagram
    participant User
    participant WebApp
    participant ServiceWorker
    participant Cache
    participant Network
    participant PushService

    User->>WebApp: App Load Request
    WebApp->>ServiceWorker: Fetch Event
    ServiceWorker->>Cache: Check Cache
    
    alt Cache Hit
        Cache-->>ServiceWorker: Cached Resource
        ServiceWorker-->>WebApp: Serve from Cache
    else Cache Miss
        ServiceWorker->>Network: Fetch from Network
        Network-->>ServiceWorker: Fresh Resource
        ServiceWorker->>Cache: Update Cache
        ServiceWorker-->>WebApp: Serve Fresh Resource
    end
    
    WebApp-->>User: App Loaded
    
    opt Background Sync
        ServiceWorker->>ServiceWorker: Background Task
        ServiceWorker->>Network: Sync Data
        Network-->>ServiceWorker: Data Synced
    end
    
    opt Push Notifications
        PushService->>ServiceWorker: Push Message
        ServiceWorker->>ServiceWorker: Show Notification
        ServiceWorker-->>User: Notification Displayed
    end
```

### Tauri Desktop Integration

```mermaid
graph TB
    subgraph "Desktop App (Tauri)"
        RUST[Rust Backend]
        WEBVIEW[WebView Frontend]
        NATIVE[Native APIs]
    end
    
    subgraph "Web App"
        VUE[Vue 3 App]
        STORES[Pinia Stores]
        SERVICES[Services]
    end
    
    subgraph "System"
        FILE_SYSTEM[File System]
        OS_APIS[OS APIs]
        WINDOW_MANAGER[Window Manager]
    end
    
    WEBVIEW --> VUE
    VUE --> STORES
    STORES --> SERVICES
    
    RUST --> NATIVE
    NATIVE --> FILE_SYSTEM
    NATIVE --> OS_APIS
    NATIVE --> WINDOW_MANAGER
    
    VUE <--> RUST
```

## Federation Network Flow

### ActivityPub Protocol Flow

```mermaid
graph TB
    subgraph "Harmony Instance"
        USER[Harmony User]
        HARMONY_API[Harmony API]
        EDGE_FUNC[Edge Functions]
        DB[Database]
    end
    
    subgraph "ActivityPub Network"
        MASTODON[Mastodon Instance]
        PLEROMA[Pleroma Instance]
        PIXELFED[PixelFed Instance]
        OTHER[Other AP Services]
    end
    
    subgraph "Discovery Services"
        WEBFINGER[WebFinger]
        NODEINFO[NodeInfo]
        WELL_KNOWN[.well-known]
    end
    
    USER --> HARMONY_API
    HARMONY_API --> EDGE_FUNC
    EDGE_FUNC --> DB
    
    EDGE_FUNC <--> WEBFINGER
    EDGE_FUNC <--> NODEINFO
    EDGE_FUNC <--> WELL_KNOWN
    
    EDGE_FUNC <--> MASTODON
    EDGE_FUNC <--> PLEROMA
    EDGE_FUNC <--> PIXELFED
    EDGE_FUNC <--> OTHER
```

### Cross-Instance Communication

```mermaid
sequenceDiagram
    participant HarmonyUser
    participant HarmonyServer
    participant MastodonServer
    participant MastodonUser

    Note over HarmonyUser,MastodonUser: User Discovery

    HarmonyUser->>HarmonyServer: Search for @user@mastodon.social
    HarmonyServer->>MastodonServer: GET /.well-known/webfinger
    MastodonServer-->>HarmonyServer: Actor info
    HarmonyServer->>MastodonServer: GET /users/username
    MastodonServer-->>HarmonyServer: Actor profile
    HarmonyServer-->>HarmonyUser: Show user profile

    Note over HarmonyUser,MastodonUser: Follow Request

    HarmonyUser->>HarmonyServer: Follow user
    HarmonyServer->>MastodonServer: POST /inbox (Follow activity)
    MastodonServer->>MastodonUser: Follow request notification
    MastodonUser->>MastodonServer: Accept follow
    MastodonServer->>HarmonyServer: POST /inbox (Accept activity)
    HarmonyServer-->>HarmonyUser: Following confirmed

    Note over HarmonyUser,MastodonUser: Content Sharing

    MastodonUser->>MastodonServer: Create post
    MastodonServer->>HarmonyServer: POST /inbox (Create activity)
    HarmonyServer-->>HarmonyUser: Show federated post
    HarmonyUser->>HarmonyServer: Like post
    HarmonyServer->>MastodonServer: POST /inbox (Like activity)
    MastodonServer-->>MastodonUser: Like notification
```

## Error Handling Flow

### Global Error Management

```mermaid
graph TB
    subgraph "Error Sources"
        API_ERROR[API Errors]
        NETWORK_ERROR[Network Errors]
        VALIDATION_ERROR[Validation Errors]
        RUNTIME_ERROR[Runtime Errors]
    end
    
    subgraph "Error Handling"
        ERROR_BOUNDARY[Error Boundary]
        ERROR_SERVICE[Error Service]
        NOTIFICATION[Notification System]
        LOGGING[Error Logging]
    end
    
    subgraph "User Feedback"
        TOAST[Toast Messages]
        MODAL[Error Modals]
        FALLBACK[Fallback UI]
        RETRY[Retry Actions]
    end
    
    API_ERROR --> ERROR_BOUNDARY
    NETWORK_ERROR --> ERROR_BOUNDARY
    VALIDATION_ERROR --> ERROR_BOUNDARY
    RUNTIME_ERROR --> ERROR_BOUNDARY
    
    ERROR_BOUNDARY --> ERROR_SERVICE
    ERROR_SERVICE --> NOTIFICATION
    ERROR_SERVICE --> LOGGING
    
    NOTIFICATION --> TOAST
    NOTIFICATION --> MODAL
    NOTIFICATION --> FALLBACK
    NOTIFICATION --> RETRY
```

## Performance Optimization Flow

### Caching Strategy

```mermaid
graph TB
    subgraph "Cache Layers"
        MEMORY[Memory Cache]
        LOCAL_STORAGE[LocalStorage]
        INDEXED_DB[IndexedDB]
        SERVICE_WORKER[SW Cache]
        CDN_CACHE[CDN Cache]
    end
    
    subgraph "Data Sources"
        API[API Endpoints]
        DATABASE[Database]
        STORAGE[File Storage]
    end
    
    subgraph "Cache Policies"
        TTL[TTL Expiration]
        LRU[LRU Eviction]
        MANUAL[Manual Invalidation]
        VERSION[Version-based]
    end
    
    API --> MEMORY
    DATABASE --> LOCAL_STORAGE
    STORAGE --> SERVICE_WORKER
    API --> CDN_CACHE
    
    MEMORY --> TTL
    LOCAL_STORAGE --> LRU
    SERVICE_WORKER --> MANUAL
    CDN_CACHE --> VERSION
```

### Bundle Loading Strategy

```mermaid
graph LR
    subgraph "Initial Load"
        CRITICAL[Critical CSS]
        APP_JS[App Shell JS]
        ROUTER[Router Config]
    end
    
    subgraph "Route-based"
        AUTH_CHUNK[Auth Routes]
        CHAT_CHUNK[Chat Routes]
        SOCIAL_CHUNK[Social Routes]
        SETTINGS_CHUNK[Settings Routes]
    end
    
    subgraph "Feature-based"
        VOICE_CHUNK[Voice Features]
        FEDERATION_CHUNK[Federation Features]
        ADMIN_CHUNK[Admin Features]
    end
    
    CRITICAL --> APP_JS
    APP_JS --> ROUTER
    
    ROUTER -.->|On Demand| AUTH_CHUNK
    ROUTER -.->|On Demand| CHAT_CHUNK
    ROUTER -.->|On Demand| SOCIAL_CHUNK
    ROUTER -.->|On Demand| SETTINGS_CHUNK
    
    CHAT_CHUNK -.->|Lazy| VOICE_CHUNK
    SOCIAL_CHUNK -.->|Lazy| FEDERATION_CHUNK
    SETTINGS_CHUNK -.->|Lazy| ADMIN_CHUNK
```

## State Persistence Flow

### Application State Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Initializing
    
    Initializing --> LoadingPersisted: Has stored state
    Initializing --> FirstTime: No stored state
    
    LoadingPersisted --> Validating: State loaded
    Validating --> Migrating: Version mismatch
    Validating --> Ready: Valid state
    
    Migrating --> Ready: Migration complete
    FirstTime --> Ready: Default state set
    
    Ready --> Active: User authenticated
    Active --> Persisting: State changes
    Persisting --> Active: State saved
    
    Active --> Cleanup: User logout
    Cleanup --> [*]: State cleared
    
    note right of Persisting
        Debounced saves
        Error handling
        Compression
    end note
```

This comprehensive flow documentation provides a complete picture of how Harmony's complex systems work together. Each flow diagram shows the interaction patterns, data movement, and system integration points that make up the application's architecture.

The documentation covers:

1. **User interaction flows** - How users interact with the system
2. **Data flows** - How data moves through the system
3. **Real-time synchronization** - How changes propagate
4. **Federation** - How external systems integrate
5. **Performance optimization** - How the system maintains speed
6. **Error handling** - How problems are managed
7. **State management** - How application state is maintained

This serves as both a development reference and architectural documentation for understanding the complete system behavior.
