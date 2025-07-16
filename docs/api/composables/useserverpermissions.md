# useServerPermissions Composable

**File:** `src/composables/useServerPermissions.ts`

## Overview

```mermaid
graph TB
    subgraph "useServerPermissions Composable"
        USERROLE[UserRole]
        USESERVERPERMISSIONS[useServerPermissions]
    end
    
    subgraph "Functions"
        USESERVERPERMISSIONS[useServerPermissions()]
    end
    
    subgraph "Interfaces"
        USERROLE[UserRole]
    end
```

## Exports

- **UserRole** - No description
- **useServerPermissions** - No description

## Functions

### `useServerPermissions()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
export function useServerPermissions() {
```




## Interfaces

### UserRole

No description available.

```typescript
export interface UserRole {
  id: string
  name: string
  permissions: ServerPermission[]
  isOwner: boolean
  isModerator: boolean
  isAdmin: boolean
  color?: string
  position: number
}
```






## Source Code Insights

**File Size:** 5876 characters
**Lines of Code:** 191
**Imports:** 4

## Usage Example

```typescript
import { UserRole, useServerPermissions } from '@/composables/useServerPermissions.ts'

// Example usage
useServerPermissions()
```

---

*This documentation was automatically generated from the source code.*