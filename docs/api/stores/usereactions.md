# useReactions Store

**File:** `src/stores/useReactions.ts`

## Overview

```mermaid
graph TB
    subgraph "useReactions Store"
        REACTIONGROUP[ReactionGroup]
        USEREACTIONSSTORE[useReactionsStore]
    end
    
    subgraph "Functions"
        CHECKLOADING[checkLoading()]
    end
    
    subgraph "Interfaces"
        REACTIONGROUP[ReactionGroup]
    end
```

## Exports

- **ReactionGroup** - No description
- **useReactionsStore** - No description

## Functions

### `checkLoading()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const checkLoading = () =>
```




## Interfaces

### ReactionGroup

No description available.

```typescript
export interface ReactionGroup {
  id: string;
  count: number;
  emoji: Emoji;
  reactions: Array<{
    reaction_id: string;
    user_id: string;
  }
```






## Source Code Insights

**File Size:** 15118 characters
**Lines of Code:** 418
**Imports:** 4

## Usage Example

```typescript
import { ReactionGroup, useReactionsStore } from '@/stores/useReactions.ts'

// Example usage
checkLoading()
```

---

*This documentation was automatically generated from the source code.*