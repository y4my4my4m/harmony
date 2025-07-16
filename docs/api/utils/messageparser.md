# messageParser Utility

**File:** `src/utils/messageParser.ts`

## Overview

```mermaid
graph TB
    subgraph "messageParser Utility"
        EMPTY[No exports]
    end
    
    subgraph "Functions"
        PARSEMESSAGECONTENT[parseMessageContent()]
    end
    
    
```



## Functions

### `parseMessageContent(message: string, usernameToUserIdMap: any)`

No description available.

**Parameters:**
- `message: string`
- `usernameToUserIdMap: any`

**Returns:** Unknown

```typescript
export async function parseMessageContent(
  message: string,
  usernameToUserIdMap: any,
): Promise<MessagePart[]> {
```


## Classes

### const

No description available.

**Methods:**
None

**Properties:**
None








## Source Code Insights

**File Size:** 4777 characters
**Lines of Code:** 134
**Imports:** 3

## Usage Example

```typescript
import { messageParser } from '@/utils/messageParser.ts'

// Example usage
parseMessageContent()
```

---

*This documentation was automatically generated from the source code.*