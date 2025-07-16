# API Reference

Welcome to the Harmony API documentation. This documentation is **automatically generated** from the TypeScript source code.

> 🤖 **Auto-Generated Documentation**: All API documentation is automatically extracted from TypeScript services, stores, composables, and types. JSDoc comments, function signatures, and type information are parsed directly from the source code.

## 📊 Quick Stats

**Total Services:** 23 auto-discovered services  
**Total Stores:** 15 Pinia stores  
**Total Composables:** 17 Vue composables  
**Total Type Files:** 1 type definitions  
**Coverage:** All TypeScript files in `src/services/`, `src/stores/`, `src/composables/`, `src/types/`

## 🚀 Auto-Generated API Documentation

### Services (23 files)
**Business logic and external integrations**

Key auto-generated service documentation:
- **[usersService](./services/usersservice.md)** - User management and profiles
- **[userDataService](./services/userdataservice.md)** - User data operations
- **[activityPubService](./services/activitypubservice.md)** - ActivityPub federation
- **[fileService](./services/fileservice.md)** - File upload and management
- **[emojiService](./services/emojiservice.md)** - Emoji and reactions
- **[inviteService](./services/inviteservice.md)** - Server invitations
- **[AdminService](./services/adminservice.md)** - Administrative functions

### Pinia Stores (15 files)
**State management with reactive data**

Key auto-generated store documentation:
- **[auth](./stores/auth.md)** - Authentication state management
- **[useChat](./stores/usechat.md)** - Chat state and messages
- **[useDM](./stores/usedm.md)** - Direct message state
- **[useActivityPub](./stores/useactivitypub.md)** - ActivityPub state
- **[useServerChannel](./stores/useserverchannel.md)** - Server and channel state
- **[useNotification](./stores/usenotification.md)** - Notification management
- **[useTheme](./stores/usetheme.md)** - Theme and appearance

### Vue Composables (17 files)
**Reusable composition functions**

Key auto-generated composable documentation:
- **[useUserData](./composables/useuserdata.md)** - User data management
- **[useLayoutState](./composables/uselayoutstate.md)** - Layout state management
- **[useMessageReactions](./composables/usemessagereactions.md)** - Message reaction handling
- **[useServerPermissions](./composables/useserverpermissions.md)** - Server permission logic
- **[usePostInteractions](./composables/usepostinteractions.md)** - Post interaction handling
- **[useAudioThemeCommon](./composables/useaudiothemecommon.md)** - Audio theme utilities

### Type Definitions (1 file)
**TypeScript interfaces and types**

- **[viewTypes](./types/viewtypes.md)** - View and layout type definitions

## 🔄 How API Documentation is Generated

The API documentation is automatically generated using:

1. **TypeScript AST Parsing** - Analyzes TypeScript source code structure
2. **JSDoc Extraction** - Parses JSDoc comments for descriptions
3. **Function Signature Analysis** - Extracts parameters, return types, exports
4. **Interface & Type Detection** - Documents TypeScript interfaces and types
5. **Mermaid Diagrams** - Auto-generates API relationship diagrams

### Regenerate API Documentation

To update the API documentation after code changes:

```bash
# Generate API docs from TypeScript files
npm run docs:generate-api

# Generate everything (components + API + TypeDoc)
npm run docs:generate-all
```

## Architecture

The API follows a layered architecture:

```mermaid
graph TB
    subgraph "Presentation Layer"
        COMPONENTS[Vue Components]
        COMPOSABLES[Vue Composables]
    end
    
    subgraph "State Management"
        STORES[Pinia Stores]
    end
    
    subgraph "Business Logic"
        SERVICES[Services]
    end
    
    subgraph "Data Layer"
        SUPABASE[Supabase]
        STORAGE[File Storage]
    end
    
    COMPONENTS --> COMPOSABLES
    COMPONENTS --> STORES
    COMPOSABLES --> STORES
    STORES --> SERVICES
    SERVICES --> SUPABASE
    SERVICES --> STORAGE
```

## Key Services

### Core Services
- **[Authentication Service](/api/services/auth)** - User authentication and session management
- **[Chat Service](/api/services/chat)** - Real-time messaging functionality
- **[ActivityPub Service](/api/services/activitypub)** - Federation and social features
- **[User Data Service](/api/services/userdata)** - User profile and data management

### Specialized Services
- **[Admin Service](/api/services/admin)** - Administrative functions
- **[File Service](/api/services/file)** - File upload and storage
- **[Emoji Service](/api/services/emoji)** - Custom emoji management
- **[Voice Service](/api/services/voice)** - WebRTC voice/video calling

## Store Architecture

Harmony uses Pinia for state management with these key stores:

### Primary Stores
- **[Auth Store](/api/stores/auth)** - Authentication state
- **[Chat Store](/api/stores/chat)** - Chat messages and channels
- **[ActivityPub Store](/api/stores/activitypub)** - Social timeline and federation
- **[Server Channel Store](/api/stores/serverchannel)** - Server and channel management

### Supporting Stores
- **[DM Store](/api/stores/dm)** - Direct message conversations
- **[Notification Store](/api/stores/notification)** - User notifications
- **[Theme Store](/api/stores/theme)** - UI theme and preferences

## Type System

Harmony is fully typed with TypeScript. Key type categories:

- **[Core Types](/api/types/core)** - Basic interfaces and enums
- **[Chat Types](/api/types/chat)** - Message, channel, and server types
- **[ActivityPub Types](/api/types/activitypub)** - Federation and social types
- **[User Types](/api/types/user)** - Profile and authentication types

## Usage Patterns

### Service Usage
```typescript
import { authService } from '@/services/authService'

// Use service methods
const user = await authService.getCurrentUser()
```

### Store Usage
```typescript
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const isLoggedIn = authStore.isLoggedIn
```

### Composable Usage
```typescript
import { useUserData } from '@/composables/useUserData'

const { getCurrentUser, updateProfile } = useUserData()
```

## Error Handling

All API methods include comprehensive error handling:

```typescript
try {
  const result = await service.method()
  // Handle success
} catch (error) {
  console.error('Operation failed:', error)
  // Handle error
}
```

## Real-time Features

Many APIs include real-time subscriptions:

```typescript
// Subscribe to real-time updates
const subscription = store.subscribeToUpdates()

// Clean up subscription
onUnmounted(() => {
  subscription?.unsubscribe()
})
```

## Performance Considerations

- **Caching**: Services implement intelligent caching
- **Pagination**: Large data sets use cursor-based pagination
- **Debouncing**: Search and input operations are debounced
- **Lazy Loading**: Components and data load on demand

## Next Steps

- Explore the [Service Documentation](/api/services/auth)
- Learn about [Store Management](/api/stores/auth)
- Check out [Component APIs](/components/)
- View [System Flow Diagrams](/flows/)

---

*This documentation is auto-generated from TypeScript code and kept in sync with the latest changes.*
