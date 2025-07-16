# Harmony System Architecture & Interconnection Flow

## 🏗️ High-Level System Architecture

```mermaid
graph TB
    subgraph "Frontend Architecture"
        subgraph "Presentation Layer"
            UI[Vue 3 Components]
            LAYOUTS[Layout System]
            VIEWS[View Components]
        end
        
        subgraph "State Management"
            STORES[Pinia Stores]
            CACHE[Caching Layer]
            PERSIST[State Persistence]
        end
        
        subgraph "Business Logic"
            SERVICES[Service Layer]
            COMPOSABLES[Vue Composables]
            UTILS[Utility Functions]
        end
        
        subgraph "Infrastructure"
            ROUTER[Vue Router]
            PWA[PWA Manager]
            SW[Service Worker]
        end
    end
    
    subgraph "Backend Infrastructure"
        SUPABASE[Supabase Platform]
        REALTIME[Real-time Engine]
        STORAGE[File Storage]
        AUTH[Authentication]
        EDGE[Edge Functions]
    end
    
    subgraph "External Systems"
        ACTIVITYPUB[ActivityPub Network]
        WEBRTC[WebRTC Infrastructure] 
        PUSH[Push Services]
        FEDERATION[Federation Network]
    end
    
    UI --> LAYOUTS
    LAYOUTS --> VIEWS
    VIEWS --> STORES
    STORES --> SERVICES
    SERVICES --> SUPABASE
    SERVICES --> EXTERNAL
    COMPOSABLES --> STORES
    UTILS --> SERVICES
    
    SUPABASE --> REALTIME
    SUPABASE --> STORAGE
    SUPABASE --> AUTH
    SUPABASE --> EDGE
    
    EDGE --> ACTIVITYPUB
    SERVICES --> WEBRTC
    PWA --> PUSH
```

## 🔄 Core Data Flow

### 1. Authentication Flow

```mermaid
sequenceDiagram
    participant User
    participant AuthStore
    participant AuthService
    participant Supabase
    participant ProfileStore
    
    User->>AuthStore: login(email, password)
    AuthStore->>Supabase: signInWithPassword()
    Supabase-->>AuthStore: session
    AuthStore->>ProfileStore: fetchProfile()
    ProfileStore->>Supabase: fetch user profile
    Supabase-->>ProfileStore: profile data
    AuthStore->>User: authenticated state
```

### 2. Chat Message Flow
```mermaid
sequenceDiagram
    participant User
    participant ChatView
    participant ChatStore
    participant ChatService
    participant Supabase
    participant OtherUsers
    
    User->>ChatView: sendMessage()
    ChatView->>ChatStore: sendMessage()
    ChatStore->>Supabase: insert message
    Supabase-->>ChatStore: message saved
    Supabase->>OtherUsers: real-time broadcast
    ChatStore->>ChatView: update UI
    ChatView->>User: message sent confirmation
```

### 3. ActivityPub Federation Flow
```mermaid
sequenceDiagram
    participant User
    participant ActivityPubStore
    participant ActivityPubService
    participant EdgeFunction
    participant RemoteInstance
    
    User->>ActivityPubStore: createPost()
    ActivityPubStore->>ActivityPubService: federateActivity()
    ActivityPubService->>EdgeFunction: queue delivery
    EdgeFunction->>RemoteInstance: HTTP POST
    RemoteInstance-->>EdgeFunction: delivery receipt
    EdgeFunction->>ActivityPubStore: update status
```

## 📁 Component Interconnection Map

### Layout System Architecture
```mermaid
graph TB
    subgraph "Layout Hierarchy"
        BASE[BaseLayout.vue]
        CHAT[ChatLayout.vue]
        SOCIAL[SocialLayout.vue]
    end
    
    subgraph "View Components"
        CHATVIEW[ChatView.vue]
        DMVIEW[DMView.vue]
        TIMELINE[TimelineView.vue]
        EXPLORE[ExploreView.vue]
        PROFILE[UserProfileView.vue]
    end
    
    subgraph "Shared Components"
        SIDEBAR[AdaptiveChannelSidebar.vue]
        CONTEXTBAR[UnifiedContextBar.vue]
        COMPOSER[MonyComposer.vue]
        MODAL[UserProfileModal.vue]
    end
    
    BASE --> CHAT
    BASE --> SOCIAL
    CHAT --> CHATVIEW
    CHAT --> DMVIEW
    SOCIAL --> TIMELINE
    SOCIAL --> EXPLORE
    SOCIAL --> PROFILE
    
    CHAT --> SIDEBAR
    SOCIAL --> SIDEBAR
    CHAT --> CONTEXTBAR
    SOCIAL --> CONTEXTBAR
    SOCIAL --> COMPOSER
    ALL --> MODAL
```

### Store Interconnections
```mermaid
graph TB
    subgraph "Authentication Layer"
        AUTH[auth.ts]
        PROFILE[useProfile.ts]
    end
    
    subgraph "Chat Domain"
        CHAT[useChat.ts]
        DM[useDM.ts]
        SERVERCHAN[useServerChannel.ts]
        SERVERUSERS[useServerUsers.ts]
        REACTIONS[useReactions.ts]
    end
    
    subgraph "Social Domain"
        ACTIVITYPUB[useActivityPub.ts]
        NOTIFICATIONS[useNotification.ts]
        PUBLICSERVERS[usePublicServers.ts]
    end
    
    subgraph "Infrastructure"
        THEME[useTheme.ts]
        EMOJI[useEmojiCache.ts]
        SERVER[server.ts]
        VOICE[unifiedVoiceChannel.ts]
        SPATIAL[spatialAudio.ts]
    end
    
    AUTH --> PROFILE
    AUTH --> CHAT
    AUTH --> ACTIVITYPUB
    
    CHAT --> SERVERCHAN
    CHAT --> SERVERUSERS
    CHAT --> REACTIONS
    DM --> SERVERUSERS
    
    ACTIVITYPUB --> NOTIFICATIONS
    ACTIVITYPUB --> PUBLICSERVERS
    
    SERVERCHAN --> EMOJI
    CHAT --> VOICE
    VOICE --> SPATIAL
```

### Service Layer Dependencies
```mermaid
graph TB
    subgraph "Core Services"
        ACTIVITYPUB_SVC[activityPubService.ts]
        CHAT_SVC[ChatService]
        USER_SVC[userDataService.ts]
        PROFILE_SVC[profileService.ts]
    end
    
    subgraph "Specialized Services"
        ADMIN_SVC[AdminService.ts]
        CONVERSATION_SVC[ConversationService.ts]
        TRENDING_SVC[TrendingService.ts]
        EMOJI_SVC[emojiService.ts]
        FILE_SVC[fileService.ts]
    end
    
    subgraph "Infrastructure Services"
        PWA_MGR[PWAManager.ts]
        SW_MGR[ServiceWorkerManager.ts]
        AUDIO_SVC[AudioThemeService.ts]
        WEBRTC_SVC[unifiedWebRTC.ts]
    end
    
    subgraph "Utility Services"
        PERMISSIONS[permissionsService.ts]
        MEMBERSHIP[membershipService.ts]
        INVITE[inviteService.ts]
        PERSISTENCE[StatePersistence.ts]
    end
    
    ACTIVITYPUB_SVC --> USER_SVC
    ACTIVITYPUB_SVC --> CONVERSATION_SVC
    CHAT_SVC --> USER_SVC
    CHAT_SVC --> EMOJI_SVC
    CHAT_SVC --> FILE_SVC
    
    ADMIN_SVC --> USER_SVC
    ADMIN_SVC --> PERMISSIONS
    
    USER_SVC --> PROFILE_SVC
    USER_SVC --> MEMBERSHIP
    
    PWA_MGR --> SW_MGR
    WEBRTC_SVC --> AUDIO_SVC
```

## 🔌 Real-time Subscription Architecture

```mermaid
graph TB
    subgraph "Supabase Real-time"
        CHANNELS[Realtime Channels]
        PRESENCE[Presence System]
        BROADCAST[Broadcast Events]
    end
    
    subgraph "Chat Subscriptions"
        CHAT_SUB[Message Subscriptions]
        DM_SUB[DM Subscriptions]
        VOICE_SUB[Voice Channel Subscriptions]
    end
    
    subgraph "Social Subscriptions"
        ACTIVITY_SUB[ActivityPub Subscriptions]
        NOTIF_SUB[Notification Subscriptions]
        FOLLOW_SUB[Follow/Unfollow Events]
    end
    
    subgraph "System Subscriptions"
        USER_SUB[User Presence]
        SERVER_SUB[Server Events]
        MEMBER_SUB[Membership Changes]
    end
    
    CHANNELS --> CHAT_SUB
    CHANNELS --> DM_SUB
    CHANNELS --> VOICE_SUB
    CHANNELS --> ACTIVITY_SUB
    CHANNELS --> NOTIF_SUB
    CHANNELS --> FOLLOW_SUB
    
    PRESENCE --> USER_SUB
    BROADCAST --> SERVER_SUB
    BROADCAST --> MEMBER_SUB
```

## 🎯 Feature Integration Map

### Unified Interface System
```mermaid
graph LR
    subgraph "Unified Interface"
        ROUTER[Vue Router]
        LAYOUTS[Layout System]
        CONTEXT[Context Management]
    end
    
    subgraph "Chat Features"
        SERVERS[Server Management]
        CHANNELS[Channel System]
        MESSAGES[Message System]
        VOICE[Voice/Video]
        DMS[Direct Messages]
    end
    
    subgraph "Social Features"
        FEDERATION[ActivityPub Federation]
        TIMELINE[Social Timeline]
        POSTS[Post Creation]
        FOLLOWS[Follow System]
        NOTIFICATIONS[Social Notifications]
    end
    
    subgraph "Shared Features"
        AUTH[Authentication]
        PROFILES[User Profiles]
        MEDIA[Media Handling]
        SEARCH[Search System]
        SETTINGS[User Settings]
    end
    
    ROUTER --> LAYOUTS
    LAYOUTS --> CONTEXT
    
    CONTEXT --> SERVERS
    CONTEXT --> FEDERATION
    
    SERVERS --> CHANNELS
    SERVERS --> MESSAGES
    SERVERS --> VOICE
    MESSAGES --> DMS
    
    FEDERATION --> TIMELINE
    FEDERATION --> POSTS
    FEDERATION --> FOLLOWS
    FEDERATION --> NOTIFICATIONS
    
    ALL --> AUTH
    ALL --> PROFILES
    ALL --> MEDIA
    ALL --> SEARCH
    ALL --> SETTINGS
```

## 📊 Data Storage Architecture

```mermaid
erDiagram
    USERS ||--o{ PROFILES : has
    USERS ||--o{ SERVERS : owns
    USERS ||--o{ MESSAGES : sends
    USERS ||--o{ ACTIVITYPUB_POSTS : creates
    
    SERVERS ||--o{ CHANNELS : contains
    SERVERS ||--o{ CATEGORIES : organizes
    SERVERS ||--o{ SERVER_USERS : members
    SERVERS ||--o{ EMOJIS : custom_emojis
    
    CHANNELS ||--o{ MESSAGES : contains
    CHANNELS ||--o{ VOICE_SESSIONS : hosts
    
    MESSAGES ||--o{ REACTIONS : receives
    MESSAGES ||--o{ ATTACHMENTS : includes
    
    ACTIVITYPUB_POSTS ||--o{ AP_ACTIVITIES : generates
    ACTIVITYPUB_POSTS ||--o{ AP_REACTIONS : receives
    
    PROFILES ||--o{ FOLLOWS : social_connections
    PROFILES ||--o{ NOTIFICATIONS : receives
    
    STORAGE_OBJECTS ||--o{ FILE_UPLOADS : stores
```

This comprehensive flow shows how all components in your Harmony codebase are interconnected, from the frontend Vue components down to the Supabase backend and external federation systems.
