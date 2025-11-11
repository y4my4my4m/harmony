# Harmony Architecture

## Overview

Harmony is a federated social platform that combines Discord-like real-time chat with ActivityPub federation, enabling seamless communication both within your instance and across the fediverse.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Frontend                             │
│                  (Vue 3 + TypeScript)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Servers    │  │  ActivityPub │  │   Direct     │      │
│  │  (Discord)   │  │  (Timeline)  │  │  Messages    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└────────┬────────────────────┬────────────────────┬──────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                      Backend API                             │
│                  (Node.js + Express)                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   REST API   │  │  ActivityPub │  │  WebSocket   │      │
│  │  Endpoints   │  │   Handlers   │  │   (Future)   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└────────┬────────────────────┬────────────────────┬──────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                      Data Layer                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Supabase    │  │    Redis     │  │  File        │      │
│  │  (Postgres)  │  │  (Caching)   │  │  Storage     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### Frontend (`/src`)

**Technology Stack:**
- Vue 3 with Composition API
- TypeScript for type safety
- Pinia for state management
- Vite for build tooling
- Vue Router for navigation

**Key Directories:**
- `/components` - Reusable UI components
- `/views` - Page-level components
- `/stores` - Pinia state stores
- `/services` - API client services
- `/composables` - Reusable composition functions
- `/utils` - Utility functions

**State Management:**
- Single source of truth for user data (`userDataService.ts`)
- Reactive stores for real-time updates
- Optimistic UI updates with rollback on failure

### Backend API (`/backend`)

**Technology Stack:**
- Node.js 20+
- Express for HTTP server
- TypeScript for type safety
- Zod for validation
- Winston for logging

**Architecture Patterns:**
- **Routes**: Handle HTTP requests, validation
- **Services**: Business logic, database operations
- **Middleware**: Authentication, rate limiting, error handling
- **Utils**: Shared utilities (cache, logger)

**Key Features:**
- JWT authentication via Supabase
- Request validation with Zod schemas
- Centralized error handling
- Rate limiting per endpoint type
- In-memory caching for performance

### ActivityPub Federation (`/backend/src/activitypub`)

**Components:**
1. **Inbox Handler**: Receives federated activities
2. **Outbox Handler**: Serves user activities
3. **Activity Processor**: Processes incoming activities
4. **Delivery Queue**: Sends activities to remote instances
5. **Signature Service**: Signs/verifies HTTP signatures
6. **Converters**: Transform between formats

**Activity Types Supported:**
- Follow/Accept/Reject
- Create (posts, messages)
- Like/EmojiReaction (Misskey compatible)
- Announce (reblog/boost)
- Update (profile, post edits)
- Delete
- Undo (any of the above)

**Federation Flow:**

Outgoing Activity:
```
1. User creates post
2. Post saved to database
3. Activity queued for delivery
4. Background worker processes queue
5. HTTP request signed with user's key
6. Activity sent to followers' inboxes
```

Incoming Activity:
```
1. Remote server POSTs to /inbox
2. Signature verified
3. Activity stored in database
4. Activity processed asynchronously
5. Local database updated
6. Real-time updates sent to connected clients
```

### Database Schema

**Core Tables:**
- `profiles` - User accounts (local + remote)
- `servers` - Discord-like servers
- `channels` - Text/voice channels in servers
- `messages` - All messages (DMs, channels)
- `posts` - ActivityPub posts
- `follows` - Follow relationships
- `post_reactions` / `message_reactions` - Emoji reactions

**Federation Tables:**
- `ap_activities` - Stored ActivityPub activities
- `federation_delivery_queue` - Outgoing deliveries

**Design Principles:**
- Local-first: Everything works without federation
- Unified content format (JSONB) for posts/messages
- Row-level security (RLS) for access control
- Triggers for real-time Supabase subscriptions

## Data Flow

### Message Creation (Discord)

```
1. User sends message in channel
2. Frontend: POST /api/messages
3. Backend: Validate, check permissions
4. Database: Insert message
5. Database trigger: Notify real-time subscribers
6. Frontend: Receive real-time update
7. UI: Display new message
```

### Post Creation (ActivityPub)

```
1. User creates post
2. Frontend: POST /api/posts
3. Backend: Save to database, get followers
4. For each remote follower:
   a. Create ActivityPub Create activity
   b. Queue delivery to follower's inbox
5. Background worker:
   a. Fetch from queue
   b. Sign HTTP request
   c. POST to remote inbox
   d. Handle success/retry
```

### Remote Post Ingestion

```
1. Remote server: POST /users/:username/inbox
2. Verify HTTP signature
3. Store activity in ap_activities
4. Process activity:
   - Create: Insert remote post
   - Like: Add reaction
   - Follow: Create follow relationship
5. Update relevant local data
6. Trigger real-time updates
```

## Security

### Authentication
- Supabase JWT tokens
- Bearer token in Authorization header
- Token verification on every request
- User context attached to requests

### Authorization
- Row-level security (RLS) in database
- Permission checks in API services
- Role-based access (owner, admin, member)
- Visibility controls (public, followers, private)

### Federation Security
- HTTP signature verification
- Actor public key fetching/caching
- Rate limiting on inbox endpoints
- Activity validation
- Domain blocking (future)

## Performance Optimizations

### Caching Strategy
- User profiles: 5-minute TTL
- Server data: Cache-then-revalidate
- Redis for distributed cache (production)
- In-memory cache for development

### Database
- Indexes on foreign keys
- Composite indexes on common queries
- JSONB GIN indexes for content search
- Connection pooling via Supabase

### API
- Response compression (gzip)
- Pagination on list endpoints
- Lazy loading for heavy resources
- CDN for static assets

## Scalability

### Horizontal Scaling
- Stateless backend (can run multiple instances)
- Redis for shared cache/sessions
- Load balancer for API requests
- CDN for frontend assets

### Queue Processing
- Background workers for delivery queue
- Exponential backoff for retries
- Priority queuing
- Batch processing capability

### Database Scaling
- Supabase handles connection pooling
- Read replicas for heavy read operations
- Archival strategy for old data
- Partitioning for large tables (future)

## Deployment Architecture

### Vercel (Recommended)
```
┌─────────────┐
│   Vercel    │
│  CDN + API  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Supabase   │
│  (Database) │
└─────────────┘
```

### Self-Hosted Docker
```
┌──────────────┐
│    Nginx     │
│  (Reverse    │
│   Proxy)     │
└───────┬──────┘
        │
        ├──────────────┬─────────────┐
        ▼              ▼             ▼
┌──────────┐    ┌──────────┐  ┌──────────┐
│ Frontend │    │ Backend  │  │  Redis   │
│(Vue/Vite)│    │ (Node.js)│  │ (Cache)  │
└──────────┘    └────┬─────┘  └──────────┘
                     │
                     ▼
               ┌──────────┐
               │Postgres  │
               │(Database)│
               └──────────┘
```

## Development Workflow

### Local Development
```bash
# Frontend (hot reload)
npm run dev

# Backend (hot reload)
cd backend && npm run dev

# Docker compose (full stack)
docker-compose -f docker-compose.dev.yml up
```

### Code Organization
- Feature-based organization
- Shared types across frontend/backend
- Reusable components/services
- Clear separation of concerns

## Future Enhancements

### Planned Features
- [ ] WebSocket for real-time without polling
- [ ] End-to-end encryption for DMs
- [ ] Media streaming for voice/video
- [ ] Full-text search with vector similarity
- [ ] Mobile apps (React Native)
- [ ] Desktop app improvements (Tauri)

### Performance Improvements
- [ ] GraphQL API option
- [ ] Service worker for offline support
- [ ] Progressive Web App enhancements
- [ ] Database query optimization
- [ ] CDN integration for media

### Federation Enhancements
- [ ] Instance blocking/muting
- [ ] Content filtering
- [ ] Relay support
- [ ] Better ActivityPub compatibility
- [ ] FEP (Fediverse Enhancement Proposals) support

## Contributing

See `CONTRIBUTING.md` for development guidelines, coding standards, and how to submit changes.

## License

MIT - See LICENSE file for details.

