# useDM Store

**File:** `src/stores/useDM.ts`

## Overview

```mermaid
graph TB
    subgraph "useDM Store"
        DMUSER[DMUser]
        DMCONVERSATION[DMConversation]
        DMCACHE[DMCache]
        USEDMSTORE[useDMStore]
    end
    
    subgraph "Functions"
        EVICTOLDESTCACHE[evictOldestCache()]
        LOADCACHEDMESSAGES[loadCachedMessages()]
        ADDMESSAGETOCACHE[addMessageToCache()]
        UPDATEMESSAGEINCACHE[updateMessageInCache()]
        REMOVEMESSAGEFROMCACHE[removeMessageFromCache()]
        CHECKCACHE[checkCache()]
        INITIALIZEDMENVIRONMENT[initializeDMEnvironment()]
        FETCHCONVERSATIONDETAILS[fetchConversationDetails()]
        INITIALIZEDMENVIRONMENTFORDIRECTACCESS[initializeDMEnvironmentForDirectAccess()]
        FETCHUSERCONVERSATIONS[fetchUserConversations()]
        FETCHCONVERSATIONMESSAGES[fetchConversationMessages()]
        SEARCHUSERS[searchUsers()]
        SETCURRENTCONVERSATION[setCurrentConversation()]
        SWITCHTOCONVERSATION[switchToConversation()]
        CLEARDMMESSAGES[clearDMMessages()]
        CLEANUPREALTIMESUBSCRIPTIONS[cleanupRealtimeSubscriptions()]
        CLEANUPCONVERSATIONSUBSCRIPTION[cleanupConversationSubscription()]
        SETUPREALTIMESUBSCRIPTIONS[setupRealtimeSubscriptions()]
        SETUPCONVERSATIONSUBSCRIPTION[setupConversationSubscription()]
        UPDATECONVERSATIONFROMMESSAGE[updateConversationFromMessage()]
        CLEANUP[cleanup()]
        PROCESSFEDERATEDDM[processFederatedDM()]
    end
    
    subgraph "Interfaces"
        DMUSER[DMUser]
        DMCONVERSATION[DMConversation]
        DMCACHE[DMCache]
    end
```

## Exports

- **DMUser** - No description
- **DMConversation** - No description
- **DMCache** - No description
- **useDMStore** - No description

## Functions

### `evictOldestCache()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const evictOldestCache = () =>
```

### `loadCachedMessages(conversationId: string)`

No description available.

**Parameters:**
- `conversationId: string`

**Returns:** Unknown

```typescript
const loadCachedMessages = (conversationId: string) =>
```

### `addMessageToCache(message: Message)`

No description available.

**Parameters:**
- `message: Message`

**Returns:** Unknown

```typescript
const addMessageToCache = (message: Message) =>
```

### `updateMessageInCache(messageId: string, updatedMessage: Message)`

No description available.

**Parameters:**
- `messageId: string`
- `updatedMessage: Message`

**Returns:** Unknown

```typescript
const updateMessageInCache = (messageId: string, updatedMessage: Message) =>
```

### `removeMessageFromCache(messageId: string)`

No description available.

**Parameters:**
- `messageId: string`

**Returns:** Unknown

```typescript
const removeMessageFromCache = (messageId: string) =>
```

### `checkCache()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const checkCache = () =>
```

### `initializeDMEnvironment(userId: string, forceRefresh = false)`

No description available.

**Parameters:**
- `userId: string`
- `forceRefresh = false`

**Returns:** Unknown

```typescript
const initializeDMEnvironment = async (userId: string, forceRefresh = false) =>
```

### `fetchConversationDetails(conversationId: string, currentUserId: string)`

No description available.

**Parameters:**
- `conversationId: string`
- `currentUserId: string`

**Returns:** Unknown

```typescript
const fetchConversationDetails = async (conversationId: string, currentUserId: string) =>
```

### `initializeDMEnvironmentForDirectAccess(userId: string, conversationId?: string)`

No description available.

**Parameters:**
- `userId: string`
- `conversationId?: string`

**Returns:** Unknown

```typescript
const initializeDMEnvironmentForDirectAccess = async (userId: string, conversationId?: string) =>
```

### `fetchUserConversations(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const fetchUserConversations = async (userId: string) =>
```

### `fetchConversationMessages(conversationId: string, beforeMessageId?: string, signal?: AbortSignal)`

No description available.

**Parameters:**
- `conversationId: string`
- `beforeMessageId?: string`
- `signal?: AbortSignal`

**Returns:** Unknown

```typescript
const fetchConversationMessages = async (conversationId: string, beforeMessageId?: string, signal?: AbortSignal) =>
```

### `searchUsers(query: string, currentUserId: string)`

No description available.

**Parameters:**
- `query: string`
- `currentUserId: string`

**Returns:** Unknown

```typescript
const searchUsers = async (query: string, currentUserId: string) =>
```

### `setCurrentConversation(conversationId: string | null)`

No description available.

**Parameters:**
- `conversationId: string | null`

**Returns:** Unknown

```typescript
const setCurrentConversation = (conversationId: string | null) =>
```

### `switchToConversation(conversationId: string)`

No description available.

**Parameters:**
- `conversationId: string`

**Returns:** Unknown

```typescript
const switchToConversation = async (conversationId: string) =>
```

### `clearDMMessages()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const clearDMMessages = () =>
```

### `cleanupRealtimeSubscriptions()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const cleanupRealtimeSubscriptions = () =>
```

### `cleanupConversationSubscription(conversationId: string)`

No description available.

**Parameters:**
- `conversationId: string`

**Returns:** Unknown

```typescript
const cleanupConversationSubscription = (conversationId: string) =>
```

### `setupRealtimeSubscriptions(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const setupRealtimeSubscriptions = async (userId: string) =>
```

### `setupConversationSubscription(conversationId: string)`

No description available.

**Parameters:**
- `conversationId: string`

**Returns:** Unknown

```typescript
const setupConversationSubscription = (conversationId: string) =>
```

### `updateConversationFromMessage(message: any)`

No description available.

**Parameters:**
- `message: any`

**Returns:** Unknown

```typescript
const updateConversationFromMessage = (message: any) =>
```

### `cleanup()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const cleanup = () =>
```

### `processFederatedDM(activity: any, note: any)`

No description available.

**Parameters:**
- `activity: any`
- `note: any`

**Returns:** Unknown

```typescript
const processFederatedDM = async (activity: any, note: any) =>
```




## Interfaces

### DMUser

No description available.

```typescript
export interface DMUser {
  id: string
  username: string
  display_name?: string
  avatar_url?: string
  is_online?: boolean
  last_seen?: string
  // Federated user support
  domain?: string
  is_local?: boolean
  federated_id?: string
  handle?: string
}
```

### DMConversation

No description available.

```typescript
export interface DMConversation {
  id: string
  user1: string
  user2: string
  created_at: string
  last_activity?: string
  last_message?: Message
  unread_count?: number
  other_user?: DMUser
}
```

### DMCache

No description available.

```typescript
export interface DMCache {
  messages: Message[]
  lastFetchedAt: Date
  oldestMessageId: string | null
  allMessagesLoaded: boolean
  lastModified: Date
}
```






## Source Code Insights

**File Size:** 43256 characters
**Lines of Code:** 1258
**Imports:** 7

## Usage Example

```typescript
import { DMUser, DMConversation, DMCache, useDMStore } from '@/stores/useDM.ts'

// Example usage
evictOldestCache()
```

---

*This documentation was automatically generated from the source code.*