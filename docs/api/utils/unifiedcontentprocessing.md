# unifiedContentProcessing Utility

**File:** `src/utils/unifiedContentProcessing.ts`

## Overview

```mermaid
graph TB
    subgraph "unifiedContentProcessing Utility"
        CONVERTMESSAGEPARTSTOACTIVITYPUBHTML[convertMessagePartsToActivityPubHTML]
        CONVERTMESSAGEPARTSTOTEXT[convertMessagePartsToText]
        EXTRACTMENTIONSFROMMESSAGEPARTS[extractMentionsFromMessageParts]
        CONVERTACTIVITYPUBHTMLTOMESSAGEPARTS[convertActivityPubHTMLToMessageParts]
        EXTRACTACTIVITYPUBATTACHMENTS[extractActivityPubAttachments]
        EXTRACTACTIVITYPUBEMOJITAGS[extractActivityPubEmojiTags]
        PARSECONTENTTOUNIFIEDFORMAT[parseContentToUnifiedFormat]
        CONVERTUNIFIEDTOACTIVITYPUBHTML[convertUnifiedToActivityPubHTML]
        RECONSTRUCTCONTENTTOTEXT[reconstructContentToText]
    end
    
    subgraph "Functions"
        RESOLVEMENTIONSUSERDATA[resolveMentionsUserData()]
        RESOLVEEMOJISDATA[resolveEmojisData()]
        PARSECONTENTTOMESSAGEPARTS[parseContentToMessageParts()]
        PARSETEXTFORURLS[parseTextForUrls()]
        PARSETEXTFOREMOJIS[parseTextForEmojis()]
        CONVERTMESSAGEPARTSTOACTIVITYPUBHTML[convertMessagePartsToActivityPubHTML()]
        CONVERTMESSAGEPARTSTOTEXT[convertMessagePartsToText()]
        EXTRACTMENTIONSFROMMESSAGEPARTS[extractMentionsFromMessageParts()]
        CONVERTACTIVITYPUBHTMLTOMESSAGEPARTS[convertActivityPubHTMLToMessageParts()]
        EXTRACTACTIVITYPUBATTACHMENTS[extractActivityPubAttachments()]
        EXTRACTACTIVITYPUBEMOJITAGS[extractActivityPubEmojiTags()]
    end
    
    
```

## Exports

- **convertMessagePartsToActivityPubHTML** - No description
- **convertMessagePartsToText** - No description
- **extractMentionsFromMessageParts** - No description
- **convertActivityPubHTMLToMessageParts** - No description
- **extractActivityPubAttachments** - No description
- **extractActivityPubEmojiTags** - No description
- **parseContentToUnifiedFormat** - No description
- **convertUnifiedToActivityPubHTML** - No description
- **reconstructContentToText** - No description

## Functions

### `resolveMentionsUserData(content: string)`

No description available.

**Parameters:**
- `content: string`

**Returns:** Unknown

```typescript
export async function resolveMentionsUserData(content: string): Promise<Record<string, {
```

### `resolveEmojisData(content: string)`

No description available.

**Parameters:**
- `content: string`

**Returns:** Unknown

```typescript
export async function resolveEmojisData(content: string): Promise<Record<string, any>> {
```

### `parseContentToMessageParts(content: string, usernameToUserDataMap: Record<string, { userId: string; isLocal: boolean; displayName?: string }> = {}, emojiDataMap: Record<string, any> = {})`

No description available.

**Parameters:**
- `content: string`
- `usernameToUserDataMap: Record<string`
- `{ userId: string; isLocal: boolean; displayName?: string }> = {}`
- `emojiDataMap: Record<string`
- `any> = {}`

**Returns:** Unknown

```typescript
export async function parseContentToMessageParts(
  content: string,
  usernameToUserDataMap: Record<string, { userId: string; isLocal: boolean; displayName?: string }> = {},
  emojiDataMap: Record<string, any> = {}
): Promise<MessagePart[]> {
```

### `parseTextForUrls(text: string, emojiDataMap: Record<string, any> = {})`

No description available.

**Parameters:**
- `text: string`
- `emojiDataMap: Record<string`
- `any> = {}`

**Returns:** Unknown

```typescript
async function parseTextForUrls(text: string, emojiDataMap: Record<string, any> = {}): Promise<MessagePart[]> {
```

### `parseTextForEmojis(text: string, emojiDataMap: Record<string, any> = {})`

No description available.

**Parameters:**
- `text: string`
- `emojiDataMap: Record<string`
- `any> = {}`

**Returns:** Unknown

```typescript
async function parseTextForEmojis(text: string, emojiDataMap: Record<string, any> = {}): Promise<MessagePart[]> {
```

### `convertMessagePartsToActivityPubHTML(parts: MessagePart[])`

No description available.

**Parameters:**
- `parts: MessagePart[]`

**Returns:** Unknown

```typescript
export function convertMessagePartsToActivityPubHTML(parts: MessagePart[]): string {
```

### `convertMessagePartsToText(parts: MessagePart[])`

No description available.

**Parameters:**
- `parts: MessagePart[]`

**Returns:** Unknown

```typescript
export function convertMessagePartsToText(parts: MessagePart[]): string {
```

### `extractMentionsFromMessageParts(parts: MessagePart[])`

No description available.

**Parameters:**
- `parts: MessagePart[]`

**Returns:** Unknown

```typescript
export function extractMentionsFromMessageParts(parts: MessagePart[]): Array<{
```

### `convertActivityPubHTMLToMessageParts(html: string)`

No description available.

**Parameters:**
- `html: string`

**Returns:** Unknown

```typescript
export function convertActivityPubHTMLToMessageParts(html: string): MessagePart[] {
```

### `extractActivityPubAttachments(parts: MessagePart[])`

No description available.

**Parameters:**
- `parts: MessagePart[]`

**Returns:** Unknown

```typescript
export function extractActivityPubAttachments(parts: MessagePart[]): any[] {
```

### `extractActivityPubEmojiTags(parts: MessagePart[], baseUrl: string = 'https://har.mony.lol')`

No description available.

**Parameters:**
- `parts: MessagePart[]`
- `baseUrl: string = 'https://har.mony.lol'`

**Returns:** Unknown

```typescript
export function extractActivityPubEmojiTags(parts: MessagePart[], baseUrl: string = 'https://har.mony.lol'): any[] {
```










## Source Code Insights

**File Size:** 13895 characters
**Lines of Code:** 435
**Imports:** 3

## Usage Example

```typescript
import { convertMessagePartsToActivityPubHTML, convertMessagePartsToText, extractMentionsFromMessageParts, convertActivityPubHTMLToMessageParts, extractActivityPubAttachments, extractActivityPubEmojiTags, parseContentToUnifiedFormat, convertUnifiedToActivityPubHTML, reconstructContentToText } from '@/utils/unifiedContentProcessing.ts'

// Example usage
resolveMentionsUserData()
```

---

*This documentation was automatically generated from the source code.*