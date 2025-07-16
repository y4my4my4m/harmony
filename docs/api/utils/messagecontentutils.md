# messageContentUtils Utility

**File:** `src/utils/messageContentUtils.ts`

## Overview

```mermaid
graph TB
    subgraph "messageContentUtils Utility"
        MESSAGEPARTSTOMARKDOWN[messagePartsToMarkdown]
        MESSAGEPARTSTOPLAINTEXT[messagePartsToPlainText]
        ISSINGLEEMOJIMESSAGE[isSingleEmojiMessage]
    end
    
    subgraph "Functions"
        MESSAGEPARTSTOMARKDOWN[messagePartsToMarkdown()]
        MESSAGEPARTSTOPLAINTEXT[messagePartsToPlainText()]
        ISSINGLEEMOJIMESSAGE[isSingleEmojiMessage()]
    end
    
    
```

## Exports

- **messagePartsToMarkdown** - No description
- **messagePartsToPlainText** - No description
- **isSingleEmojiMessage** - No description

## Functions

### `messagePartsToMarkdown(parts: MessagePart[])`

No description available.

**Parameters:**
- `parts: MessagePart[]`

**Returns:** Unknown

```typescript
export function messagePartsToMarkdown(parts: MessagePart[]): string {
```

### `messagePartsToPlainText(parts: MessagePart[])`

No description available.

**Parameters:**
- `parts: MessagePart[]`

**Returns:** Unknown

```typescript
export function messagePartsToPlainText(parts: MessagePart[]): string {
```

### `isSingleEmojiMessage(parts: MessagePart[])`

No description available.

**Parameters:**
- `parts: MessagePart[]`

**Returns:** Unknown

```typescript
export function isSingleEmojiMessage(parts: MessagePart[]): boolean {
```










## Source Code Insights

**File Size:** 1860 characters
**Lines of Code:** 85
**Imports:** 1

## Usage Example

```typescript
import { messagePartsToMarkdown, messagePartsToPlainText, isSingleEmojiMessage } from '@/utils/messageContentUtils.ts'

// Example usage
messagePartsToMarkdown()
```

---

*This documentation was automatically generated from the source code.*