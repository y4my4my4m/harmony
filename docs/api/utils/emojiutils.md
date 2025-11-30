# emojiUtils Utility

**File:** `src/utils/emojiUtils.ts`

## Overview

```mermaid
graph TB
    subgraph "emojiUtils Utility"
        GETEMOJIURL[getEmojiUrl]
    end
    
    subgraph "Functions"
        FN_GETEMOJIURL[getEmojiUrl]
    end
```


## Exports

- **getEmojiUrl** - function export

## Functions

### `getEmojiUrl(emojiUrl: string | null | undefined, size: number = 48)`

No description available.

**Parameters:**
- `emojiUrl: string | null | undefined`
- `size: number = 48`

**Returns:** `string`

```typescript
/**
 * Get the public URL for an emoji, handling both local and remote emojis
 * Local emojis are processed through Supabase storage with transformation
 * Remote emojis (from federated instances) are returned as-is
 */
export function getEmojiUrl(emojiUrl: string | null | undefined, size: number = 48): string
```












## Source Code Insights

**File Size:** 1640 characters
**Lines of Code:** 41
**Imports:** 1

## Usage Example

```typescript
import { getEmojiUrl } from '@/utils/emojiUtils'

// Example usage
getEmojiUrl()
```

---

*This documentation was automatically generated from the source code.*