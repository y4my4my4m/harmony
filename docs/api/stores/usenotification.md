# useNotification Store

**File:** `src/stores/useNotification.ts`

## Overview

```mermaid
graph TB
    subgraph "useNotification Store"
        USENOTIFICATIONSTORE[useNotificationStore]
    end
    
    subgraph "Functions"
        TIMESTRINGTOMINUTES[timeStringToMinutes()]
    end
    
    subgraph "Interfaces"
        NOTIFICATIONSTATE[NotificationState]
    end
```

## Exports

- **useNotificationStore** - No description

## Functions

### `timeStringToMinutes(timeString: string)`

No description available.

**Parameters:**
- `timeString: string`

**Returns:** Unknown

```typescript
function timeStringToMinutes(timeString: string): number {
```




## Interfaces

### NotificationState

No description available.

```typescript
interface NotificationState {
  notifications: Notification[]
  unreadCount: number
  isLoading: boolean
  lastFetchedAt: Date | null
  preferences: NotificationPreferences | null
  isDndActive: boolean
  toasts: NotificationToast[]
  realtimeSubscription: any
  lastNotificationTime: Map<string, number>
  isInitialized: boolean
  hasPermission: boolean
  currentFilter: string
}
```






## Source Code Insights

**File Size:** 31741 characters
**Lines of Code:** 952
**Imports:** 7

## Usage Example

```typescript
import { useNotificationStore } from '@/stores/useNotification.ts'

// Example usage
timeStringToMinutes()
```

---

*This documentation was automatically generated from the source code.*