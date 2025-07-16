# useUserData Composable

**File:** `src/composables/useUserData.ts`

## Overview

```mermaid
graph TB
    subgraph "useUserData Composable"
        USEUSERDATA[useUserData]
    end
    
    subgraph "Functions"
        USEUSERDATA[useUserData()]
        TRIGGERUPDATE[triggerUpdate()]
        SETUPEVENTLISTENERS[setupEventListeners()]
        CLEANUPEVENTLISTENERS[cleanupEventListeners()]
        ENSUREINITIALIZED[ensureInitialized()]
        GETUSER[getUser()]
        GETUSERAVATARURL[getUserAvatarUrl()]
        GETUSERDISPLAYNAME[getUserDisplayName()]
        GETUSERSTATUSFORAVATAR[getUserStatusForAvatar()]
        GETUSERSTATUSTEXT[getUserStatusText()]
        GETUSERCOLOR[getUserColor()]
        ISUSERONLINE[isUserOnline()]
        GETUSERSTATUS[getUserStatus()]
        GETUSERCREATEDAT[getUserCreatedAt()]
        GETUSERPROFILE[getUserProfile()]
        GETUSERBIO[getUserBio()]
        GETUSERROLES[getUserRoles()]
        GETUSERMESSAGECOUNT[getUserMessageCount()]
        GETUSERVOICETIME[getUserVoiceTime()]
        FETCHUSERPROFILE[fetchUserProfile()]
        FETCHMULTIPLEUSERPROFILES[fetchMultipleUserProfiles()]
        ENSUREPROFILESAVAILABLE[ensureProfilesAvailable()]
        INITIALIZE[initialize()]
        SUBSCRIBETOCONTEXT[subscribeToContext()]
        UNSUBSCRIBEFROMCONTEXT[unsubscribeFromContext()]
        UPDATECURRENTUSERSTATUS[updateCurrentUserStatus()]
        UPDATECURRENTUSERPROFILE[updateCurrentUserProfile()]
        REFRESH[refresh()]
        GETUSERSINCONTEXT[getUsersInContext()]
    end
    
    
```

## Exports

- **useUserData** - No description

## Functions

### `useUserData()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
export function useUserData() {
```

### `triggerUpdate()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const triggerUpdate = () =>
```

### `setupEventListeners()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const setupEventListeners = () =>
```

### `cleanupEventListeners()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const cleanupEventListeners = () =>
```

### `ensureInitialized()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const ensureInitialized = async () =>
```

### `getUser(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUser = (userId: string) =>
```

### `getUserAvatarUrl(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserAvatarUrl = (userId: string) =>
```

### `getUserDisplayName(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserDisplayName = (userId: string) =>
```

### `getUserStatusForAvatar(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserStatusForAvatar = (userId: string) =>
```

### `getUserStatusText(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserStatusText = (userId: string) =>
```

### `getUserColor(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserColor = (userId: string) =>
```

### `isUserOnline(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const isUserOnline = (userId: string) =>
```

### `getUserStatus(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserStatus = (userId: string) =>
```

### `getUserCreatedAt(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserCreatedAt = (userId: string) =>
```

### `getUserProfile(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserProfile = (userId: string) =>
```

### `getUserBio(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserBio = (userId: string) =>
```

### `getUserRoles(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserRoles = (userId: string) =>
```

### `getUserMessageCount(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserMessageCount = (userId: string) =>
```

### `getUserVoiceTime(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUserVoiceTime = (userId: string) =>
```

### `fetchUserProfile(userId: string, forceRefresh: boolean = false)`

No description available.

**Parameters:**
- `userId: string`
- `forceRefresh: boolean = false`

**Returns:** Unknown

```typescript
const fetchUserProfile = async (userId: string, forceRefresh: boolean = false) =>
```

### `fetchMultipleUserProfiles(userIds: string[], forceRefresh: boolean = false)`

No description available.

**Parameters:**
- `userIds: string[]`
- `forceRefresh: boolean = false`

**Returns:** Unknown

```typescript
const fetchMultipleUserProfiles = async (userIds: string[], forceRefresh: boolean = false) =>
```

### `ensureProfilesAvailable(userIds: string[])`

No description available.

**Parameters:**
- `userIds: string[]`

**Returns:** Unknown

```typescript
const ensureProfilesAvailable = async (userIds: string[]) =>
```

### `initialize(userId: string, username: string, avatarUrl?: string)`

No description available.

**Parameters:**
- `userId: string`
- `username: string`
- `avatarUrl?: string`

**Returns:** Unknown

```typescript
const initialize = async (userId: string, username: string, avatarUrl?: string) =>
```

### `subscribeToContext(contextId: string, type: 'server' | 'dm', userIds: string[])`

No description available.

**Parameters:**
- `contextId: string`
- `type: 'server' | 'dm'`
- `userIds: string[]`

**Returns:** Unknown

```typescript
const subscribeToContext = async (contextId: string, type: 'server' | 'dm', userIds: string[]) =>
```

### `unsubscribeFromContext(contextId: string)`

No description available.

**Parameters:**
- `contextId: string`

**Returns:** Unknown

```typescript
const unsubscribeFromContext = async (contextId: string) =>
```

### `updateCurrentUserStatus(status: UserStatus)`

No description available.

**Parameters:**
- `status: UserStatus`

**Returns:** Unknown

```typescript
const updateCurrentUserStatus = async (status: UserStatus) =>
```

### `updateCurrentUserProfile(profileData: {
    displayName?: string
    avatarUrl?: string
    color?: string
    bio?: string
  })`

No description available.

**Parameters:**
- `profileData: {
    displayName?: string
    avatarUrl?: string
    color?: string
    bio?: string
  }`

**Returns:** Unknown

```typescript
const updateCurrentUserProfile = async (profileData: {
    displayName?: string
    avatarUrl?: string
    color?: string
    bio?: string
  }) =>
```

### `refresh()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const refresh = async () =>
```

### `getUsersInContext(contextId: string)`

No description available.

**Parameters:**
- `contextId: string`

**Returns:** Unknown

```typescript
const getUsersInContext = (contextId: string) =>
```










## Source Code Insights

**File Size:** 10369 characters
**Lines of Code:** 405
**Imports:** 4

## Usage Example

```typescript
import { useUserData } from '@/composables/useUserData.ts'

// Example usage
useUserData()
```

---

*This documentation was automatically generated from the source code.*