# useUserState Composable

**File:** `src/composables/useUserState.ts`

## Overview

```mermaid
graph TB
    subgraph "useUserState Composable"
        USEUSERSTATE[useUserState]
    end
    
    subgraph "Functions"
        USEUSERSTATE[useUserState()]
        BROADCASTPROFILEUPDATE[broadcastProfileUpdate()]
        UPDATEUSERSTATUS[updateUserStatus()]
        GETCURRENTUSER[getCurrentUser()]
        GETUSER[getUser()]
        GETSTATS[getStats()]
    end
    
    
```

## Exports

- **useUserState** - No description

## Functions

### `useUserState()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
export function useUserState() {
```

### `broadcastProfileUpdate(profileData: {
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
const broadcastProfileUpdate = async (profileData: {
    displayName?: string
    avatarUrl?: string
    color?: string
    bio?: string
  }) =>
```

### `updateUserStatus(status: number)`

No description available.

**Parameters:**
- `status: number`

**Returns:** Unknown

```typescript
const updateUserStatus = async (status: number) =>
```

### `getCurrentUser()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const getCurrentUser = () =>
```

### `getUser(userId: string)`

No description available.

**Parameters:**
- `userId: string`

**Returns:** Unknown

```typescript
const getUser = (userId: string) =>
```

### `getStats()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const getStats = () =>
```










## Source Code Insights

**File Size:** 1763 characters
**Lines of Code:** 77
**Imports:** 1

## Usage Example

```typescript
import { useUserState } from '@/composables/useUserState.ts'

// Example usage
useUserState()
```

---

*This documentation was automatically generated from the source code.*