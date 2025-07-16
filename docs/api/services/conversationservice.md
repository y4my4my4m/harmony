# ConversationService Service

**File:** `src/services/ConversationService.ts`

## Overview

```mermaid
graph TB
    subgraph "ConversationService Service"
        CONVERSATIONSERVICE[ConversationService]
        DEFAULT[default]
    end
    
    subgraph "Functions"
        SORTREPLIES[sortReplies()]
    end
    
    
```

## Exports

- **ConversationService** - No description
- **default** - No description

## Functions

### `sortReplies(post: ActivityPubPost & { replies?: ActivityPubPost[] })`

No description available.

**Parameters:**
- `post: ActivityPubPost & { replies?: ActivityPubPost[] }`

**Returns:** Unknown

```typescript
const sortReplies = (post: ActivityPubPost & { replies?: ActivityPubPost[] }) =>
```


## Classes

### ConversationService

No description available.

**Methods:**
- `O`

**Properties:**
- `postId`
- `post`








## Source Code Insights

**File Size:** 7976 characters
**Lines of Code:** 259
**Imports:** 2

## Usage Example

```typescript
import { ConversationService, default } from '@/services/ConversationService.ts'

// Example usage
sortReplies()
```

---

*This documentation was automatically generated from the source code.*