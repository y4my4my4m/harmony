# System Architecture

Harmony is built on a modern, scalable architecture that combines the best of federated social networking with real-time chat capabilities.

## High-Level Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        VUE[Vue 3 App]
        TAURI[Tauri Desktop]
        PWA[Progressive Web App]
    end
    
    subgraph "Frontend Technologies"
        VITE[Vite Build Tool]
        TS[TypeScript]
        PINIA[Pinia State Management]
        ROUTER[Vue Router]
    end
    
    subgraph "Backend Services"
        SUPABASE[Supabase Backend]
        EDGE[Edge Functions]
        REALTIME[Real-time Subscriptions]
        AUTH[Authentication]
        STORAGE[File Storage]
    end
    
    subgraph "External Protocols"
        ACTIVITYPUB[ActivityPub]
        WEBRTC[WebRTC Voice/Video]
        FEDERATION[Federation Network]
    end
    
    VUE --> VITE
    VUE --> TS
    VUE --> PINIA
    VUE --> ROUTER
    
    VUE --> SUPABASE
    SUPABASE --> EDGE
    SUPABASE --> REALTIME
    SUPABASE --> AUTH
    SUPABASE --> STORAGE
    
    EDGE --> ACTIVITYPUB
    VUE --> WEBRTC
    ACTIVITYPUB --> FEDERATION
```

## Technology Stack

### Frontend
- **Vue 3** - Progressive JavaScript framework with Composition API
- **TypeScript** - Type-safe JavaScript development
- **Vite** - Fast build tool and development server
- **Pinia** - State management for Vue.js
- **Vue Router** - Client-side routing
- **Tauri** - Desktop application framework

### Backend
- **Supabase** - Backend-as-a-Service platform
- **PostgreSQL** - Primary database
- **Edge Functions** - Serverless API endpoints
- **Real-time Engine** - WebSocket-based real-time updates
- **Row Level Security** - Database-level authorization

### Protocols & Standards
- **ActivityPub** - W3C standard for federated social networking
- **WebRTC** - Real-time communication for voice/video
- **WebSockets** - Real-time bidirectional communication

## Core Modules

### 1. Authentication & User Management

```mermaid
graph LR
    USER[User] --> AUTH[Auth Service]
    AUTH --> SUPABASE[Supabase Auth]
    AUTH --> PROFILE[Profile Service]
    PROFILE --> DB[(Database)]
    AUTH --> SESSION[Session Management]
```

**Key Components:**
- JWT-based authentication
- OAuth providers (GitHub, Google, etc.)
- Profile management
- Session persistence
- Role-based access control

### 2. Real-time Chat System

```mermaid
graph TB
    subgraph "Chat Architecture"
        INPUT[Message Input] --> CHAT[Chat Service]
        CHAT --> VALIDATION[Message Validation]
        VALIDATION --> STORAGE[Message Storage]
        STORAGE --> REALTIME[Real-time Broadcast]
        REALTIME --> DISPLAY[Message Display]
        
        CHAT --> REACTIONS[Reaction System]
        CHAT --> REPLIES[Reply System]
        CHAT --> FILES[File Handling]
    end
```

**Features:**
- Real-time message delivery
- Rich text formatting
- File attachments
- Message reactions
- Reply threading
- Message history

### 3. ActivityPub Federation

```mermaid
graph TB
    subgraph "Federation Layer"
        LOCAL[Local Instance] --> OUTBOX[Outbox]
        OUTBOX --> DELIVERY[Activity Delivery]
        DELIVERY --> REMOTE[Remote Instances]
        
        REMOTE --> INBOX[Inbox]
        INBOX --> PROCESSING[Activity Processing]
        PROCESSING --> LOCAL_STORE[Local Storage]
        
        WEBFINGER[WebFinger] --> DISCOVERY[Actor Discovery]
        DISCOVERY --> FOLLOWING[Following System]
    end
```

**Capabilities:**
- Cross-instance communication
- User discovery via WebFinger
- Activity delivery and processing
- Content synchronization
- Privacy controls

### 4. Voice & Video Communication

```mermaid
graph LR
    USER1[User A] --> WEBRTC[WebRTC Engine]
    USER2[User B] --> WEBRTC
    WEBRTC --> SPATIAL[Spatial Audio]
    WEBRTC --> CHANNELS[Voice Channels]
    SPATIAL --> PROCESSING[Audio Processing]
```

**Technologies:**
- MediaSoup for scalable media
- Spatial audio positioning
- Voice activity detection
- Noise suppression
- Screen sharing

## Data Flow Architecture

### Message Flow

```mermaid
sequenceDiagram
    participant User
    participant Vue App
    participant Pinia Store
    participant Supabase
    participant Other Users
    
    User->>Vue App: Type message
    Vue App->>Pinia Store: Update draft state
    User->>Vue App: Send message
    Vue App->>Pinia Store: Dispatch send action
    Pinia Store->>Supabase: Insert message
    Supabase->>Supabase: Validate & store
    Supabase-->>Other Users: Real-time broadcast
    Supabase-->>Pinia Store: Confirm delivery
    Pinia Store-->>Vue App: Update UI state
```

### Federation Flow

```mermaid
sequenceDiagram
    participant Local User
    participant Harmony Instance
    participant Remote Instance
    participant Remote User
    
    Local User->>Harmony Instance: Create post
    Harmony Instance->>Harmony Instance: Store locally
    Harmony Instance->>Remote Instance: Send Activity (POST)
    Remote Instance->>Remote Instance: Validate signature
    Remote Instance->>Remote Instance: Process activity
    Remote Instance-->>Remote User: Display content
    Remote User->>Remote Instance: React to post
    Remote Instance->>Harmony Instance: Send reaction Activity
    Harmony Instance-->>Local User: Show reaction
```

## Security Architecture

### Authentication Flow

```mermaid
graph TB
    subgraph "Security Layers"
        FRONTEND[Frontend Auth] --> JWT[JWT Tokens]
        JWT --> RLS[Row Level Security]
        RLS --> POLICIES[Security Policies]
        
        FEDERATION[Federation] --> SIGNATURES[HTTP Signatures]
        SIGNATURES --> VERIFICATION[Key Verification]
        VERIFICATION --> TRUST[Trust Network]
    end
```

**Security Measures:**
- JWT token authentication
- Row-level security in database
- HTTP signature verification for federation
- CORS protection
- Rate limiting
- Input validation and sanitization

## Scalability Considerations

### Horizontal Scaling

```mermaid
graph TB
    subgraph "Load Distribution"
        LB[Load Balancer] --> APP1[App Instance 1]
        LB --> APP2[App Instance 2]
        LB --> APP3[App Instance 3]
        
        APP1 --> DB[Shared Database]
        APP2 --> DB
        APP3 --> DB
        
        DB --> CACHE[Redis Cache]
        DB --> CDN[CDN for Assets]
    end
```

**Scaling Strategies:**
- Stateless application design
- Database connection pooling
- CDN for static assets
- Caching for frequently accessed data
- Microservice architecture preparation

## Development Architecture

### Code Organization

```
src/
├── components/          # Vue components
│   ├── chat/           # Chat-specific components
│   ├── activitypub/    # Federation components
│   └── shared/         # Reusable components
├── stores/             # Pinia state stores
├── services/           # Business logic services
├── composables/        # Vue composition functions
├── types/              # TypeScript type definitions
└── utils/              # Utility functions
```

### Build Pipeline

```mermaid
graph LR
    SOURCE[Source Code] --> VITE[Vite Bundler]
    VITE --> TS[TypeScript Check]
    TS --> LINT[ESLint]
    LINT --> TEST[Unit Tests]
    TEST --> BUILD[Production Build]
    BUILD --> DEPLOY[Deployment]
```

This architecture ensures Harmony is:
- **Scalable** - Can handle growing user bases
- **Maintainable** - Clear separation of concerns
- **Secure** - Multiple layers of protection
- **Federated** - Interoperable with other instances
- **Real-time** - Instant communication capabilities
- **Modern** - Uses current best practices and technologies
