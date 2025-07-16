# mentionMigration Utility

**File:** `src/utils/mentionMigration.ts`

## Overview

```mermaid
graph TB
    subgraph "mentionMigration Utility"
        MIGRATELEGACYMENTIONS[migrateLegacyMentions]
        VALIDATEMENTIONSTRUCTURE[validateMentionStructure]
        CREATEMENTIONFROMUSER[createMentionFromUser]
        FORMATMENTIONFORDISPLAY[formatMentionForDisplay]
        PARSEDISPLAYMENTION[parseDisplayMention]
    end
    
    subgraph "Functions"
        MIGRATELEGACYMENTIONS[migrateLegacyMentions()]
        VALIDATEMENTIONSTRUCTURE[validateMentionStructure()]
        CREATEMENTIONFROMUSER[createMentionFromUser()]
        FORMATMENTIONFORDISPLAY[formatMentionForDisplay()]
        PARSEDISPLAYMENTION[parseDisplayMention()]
    end
    
    
```

## Exports

- **migrateLegacyMentions** - No description
- **validateMentionStructure** - No description
- **createMentionFromUser** - No description
- **formatMentionForDisplay** - No description
- **parseDisplayMention** - No description

## Functions

### `migrateLegacyMentions(content: MessagePart[])`

No description available.

**Parameters:**
- `content: MessagePart[]`

**Returns:** Unknown

```typescript
export function migrateLegacyMentions(content: MessagePart[]): MessagePart[] {
```

### `validateMentionStructure(mention: MentionContent)`

No description available.

**Parameters:**
- `mention: MentionContent`

**Returns:** Unknown

```typescript
export function validateMentionStructure(mention: MentionContent): boolean {
```

### `createMentionFromUser(userId: string, userProfile?: any)`

No description available.

**Parameters:**
- `userId: string`
- `userProfile?: any`

**Returns:** Unknown

```typescript
export function createMentionFromUser(userId: string, userProfile?: any): MentionContent | null {
```

### `formatMentionForDisplay(mention: MentionContent)`

No description available.

**Parameters:**
- `mention: MentionContent`

**Returns:** Unknown

```typescript
export function formatMentionForDisplay(mention: MentionContent): string {
```

### `parseDisplayMention(displayMention: string)`

No description available.

**Parameters:**
- `displayMention: string`

**Returns:** Unknown

```typescript
export function parseDisplayMention(displayMention: string): MentionContent | null {
```










## Source Code Insights

**File Size:** 3706 characters
**Lines of Code:** 121
**Imports:** 2

## Usage Example

```typescript
import { migrateLegacyMentions, validateMentionStructure, createMentionFromUser, formatMentionForDisplay, parseDisplayMention } from '@/utils/mentionMigration.ts'

// Example usage
migrateLegacyMentions()
```

---

*This documentation was automatically generated from the source code.*