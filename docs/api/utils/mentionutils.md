# mentionUtils Utility

**File:** `src/utils/mentionUtils.ts`

## Overview

```mermaid
graph TB
    subgraph "mentionUtils Utility"
        MENTIONMATCH[MentionMatch]
        RESOLVEDMENTION[ResolvedMention]
        EXTRACTMENTIONS[extractMentions]
        GENERATEMENTIONTAGS[generateMentionTags]
        GETDELIVERYINBOXES[getDeliveryInboxes]
        FORMATMENTIONSFORACTIVITYPUB[formatMentionsForActivityPub]
    end
    
    subgraph "Functions"
        EXTRACTMENTIONS[extractMentions()]
        RESOLVEMENTIONS[resolveMentions()]
        GENERATEMENTIONTAGS[generateMentionTags()]
        GETDELIVERYINBOXES[getDeliveryInboxes()]
        FORMATMENTIONSFORACTIVITYPUB[formatMentionsForActivityPub()]
        RESOLVEREMOTEMENTION[resolveRemoteMention()]
    end
    
    subgraph "Interfaces"
        MENTIONMATCH[MentionMatch]
        RESOLVEDMENTION[ResolvedMention]
    end
```

## Exports

- **MentionMatch** - No description
- **ResolvedMention** - No description
- **extractMentions** - No description
- **generateMentionTags** - No description
- **getDeliveryInboxes** - No description
- **formatMentionsForActivityPub** - No description

## Functions

### `extractMentions(text: string)`

No description available.

**Parameters:**
- `text: string`

**Returns:** Unknown

```typescript
export function extractMentions(text: string): MentionMatch[] {
```

### `resolveMentions(mentions: MentionMatch[])`

No description available.

**Parameters:**
- `mentions: MentionMatch[]`

**Returns:** Unknown

```typescript
export async function resolveMentions(mentions: MentionMatch[]): Promise<ResolvedMention[]> {
```

### `generateMentionTags(resolvedMentions: ResolvedMention[])`

No description available.

**Parameters:**
- `resolvedMentions: ResolvedMention[]`

**Returns:** Unknown

```typescript
export function generateMentionTags(resolvedMentions: ResolvedMention[]): any[] {
```

### `getDeliveryInboxes(resolvedMentions: ResolvedMention[])`

No description available.

**Parameters:**
- `resolvedMentions: ResolvedMention[]`

**Returns:** Unknown

```typescript
export function getDeliveryInboxes(resolvedMentions: ResolvedMention[]): string[] {
```

### `formatMentionsForActivityPub(text: string, resolvedMentions: ResolvedMention[])`

No description available.

**Parameters:**
- `text: string`
- `resolvedMentions: ResolvedMention[]`

**Returns:** Unknown

```typescript
export function formatMentionsForActivityPub(
  text: string, 
  resolvedMentions: ResolvedMention[]
): string {
```

### `resolveRemoteMention(username: string, domain: string)`

No description available.

**Parameters:**
- `username: string`
- `domain: string`

**Returns:** Unknown

```typescript
export async function resolveRemoteMention(username: string, domain: string): Promise<FederatedUser | null> {
```




## Interfaces

### MentionMatch

No description available.

```typescript
export interface MentionMatch {
  full: string;          // "@tester004@mastodon.social"
  username: string;      // "tester004"
  domain?: string;       // "mastodon.social" or undefined for local
  startIndex: number;
  endIndex: number;
}
```

### ResolvedMention

No description available.

```typescript
export interface ResolvedMention {
  mention: MentionMatch;
  user?: UserData;
  inboxUrl?: string;
  actorUrl?: string;
}
```






## Source Code Insights

**File Size:** 7914 characters
**Lines of Code:** 275
**Imports:** 2

## Usage Example

```typescript
import { MentionMatch, ResolvedMention, extractMentions, generateMentionTags, getDeliveryInboxes, formatMentionsForActivityPub } from '@/utils/mentionUtils.ts'

// Example usage
extractMentions()
```

---

*This documentation was automatically generated from the source code.*