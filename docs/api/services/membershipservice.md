# membershipService Service

**File:** `src/services/membershipService.ts`

## Overview

```mermaid
graph TB
    subgraph "membershipService Service"
        MEMBERSHIPEVENT[MembershipEvent]
        MEMBERSHIPSERVICEOPTIONS[MembershipServiceOptions]
        MEMBERSHIPSERVICE[MembershipService]
        GETMEMBERSHIPSERVICE[getMembershipService]
    end
    
    subgraph "Functions"
        GETMEMBERSHIPSERVICE[getMembershipService()]
    end
    
    subgraph "Interfaces"
        MEMBERSHIPEVENT[MembershipEvent]
        MEMBERSHIPSERVICEOPTIONS[MembershipServiceOptions]
    end
```

## Exports

- **MembershipEvent** - No description
- **MembershipServiceOptions** - No description
- **MembershipService** - No description
- **getMembershipService** - No description

## Functions

### `getMembershipService()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
export function getMembershipService(): MembershipService {
```


## Classes

### MembershipService

No description available.

**Methods:**
- `Map`

**Properties:**
- `subscriptions`
- `options`
- `MembershipServiceOptions`


## Interfaces

### MembershipEvent

No description available.

```typescript
export interface MembershipEvent {
  id: string
  server_id: string
  user_id: string
  event_type: 'join' | 'leave' | 'kick' | 'ban'
  initiated_by?: string
  metadata: {
    username?: string
    display_name?: string
    joined_at?: string
    left_at?: string
    via_invite?: boolean
  }
```

### MembershipServiceOptions

No description available.

```typescript
export interface MembershipServiceOptions {
  onUserJoin?: (event: MembershipEvent) => void
  onUserLeave?: (event: MembershipEvent) => void
  onError?: (error: Error) => void
}
```






## Source Code Insights

**File Size:** 7351 characters
**Lines of Code:** 232
**Imports:** 4

## Usage Example

```typescript
import { MembershipEvent, MembershipServiceOptions, MembershipService, getMembershipService } from '@/services/membershipService.ts'

// Example usage
getMembershipService()
```

---

*This documentation was automatically generated from the source code.*