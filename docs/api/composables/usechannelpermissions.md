# useChannelPermissions Composable

**File:** `src/composables/useChannelPermissions.ts`

## Overview

```mermaid
graph TB
    subgraph "useChannelPermissions Composable"
        USECHANNELPERMISSIONS[useChannelPermissions]
    end
    
    subgraph "Functions"
        FN_USECHANNELPERMISSIONS[useChannelPermissions]
        FN_CANVIEWCHANNEL[canViewChannel]
        FN_CANACCESSCHANNEL[canAccessChannel]
        FN_GETDRAGCURSOR[getDragCursor]
        FN_VALIDATEDRAGANDDROP[validateDragAndDrop]
    end
```


## Exports

- **useChannelPermissions** - function export

## Functions

### `useChannelPermissions()`

No description available.

**Parameters:**
None

**Returns:** `void`

```typescript
export function useChannelPermissions()
```

### `canViewChannel(_channelId: string)`

No description available.

**Parameters:**
- `_channelId: string`

**Returns:** `Unknown`

```typescript
const canViewChannel = (_channelId: string) =>
```

### `canAccessChannel(_channelId: string)`

No description available.

**Parameters:**
- `_channelId: string`

**Returns:** `Unknown`

```typescript
const canAccessChannel = (_channelId: string) =>
```

### `getDragCursor(itemType: 'channel' | 'category', isDragging = false)`

No description available.

**Parameters:**
- `itemType: 'channel' | 'category'`
- `isDragging = false`

**Returns:** `Unknown`

```typescript
const getDragCursor = (itemType: 'channel' | 'category', isDragging = false) =>
```

### `validateDragAndDrop(itemType: string, dropType: string)`

No description available.

**Parameters:**
- `itemType: string`
- `dropType: string`

**Returns:** `Unknown`

```typescript
const validateDragAndDrop = (itemType: string, dropType: string) =>
```












## Source Code Insights

**File Size:** 3408 characters
**Lines of Code:** 118
**Imports:** 2

## Usage Example

```typescript
import { useChannelPermissions } from '@/composables/useChannelPermissions'

// Example usage
useChannelPermissions()
```

---

*This documentation was automatically generated from the source code.*