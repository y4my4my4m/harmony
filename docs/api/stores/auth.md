# auth Store

**File:** `src/stores/auth.ts`

## Overview

```mermaid
graph TB
    subgraph "auth Store"
        USEAUTHSTORE[useAuthStore]
    end
    
    subgraph "Functions"
        HANDLEBEFOREUNLOAD[handleBeforeUnload()]
        HANDLEVISIBILITYCHANGE[handleVisibilityChange()]
    end
    
    
```

## Exports

- **useAuthStore** - No description

## Functions

### `handleBeforeUnload(event: BeforeUnloadEvent)`

No description available.

**Parameters:**
- `event: BeforeUnloadEvent`

**Returns:** Unknown

```typescript
const handleBeforeUnload = (event: BeforeUnloadEvent) =>
```

### `handleVisibilityChange()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const handleVisibilityChange = async () =>
```










## Source Code Insights

**File Size:** 7605 characters
**Lines of Code:** 208
**Imports:** 6

## Usage Example

```typescript
import { useAuthStore } from '@/stores/auth.ts'

// Example usage
handleBeforeUnload()
```

---

*This documentation was automatically generated from the source code.*