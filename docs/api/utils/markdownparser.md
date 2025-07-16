# markdownParser Utility

**File:** `src/utils/markdownParser.ts`

## Overview

```mermaid
graph TB
    subgraph "markdownParser Utility"
        MARKDOWNNODE[MarkdownNode]
        PARSEDCONTENT[ParsedContent]
        MARKDOWNTOKEN[MarkdownToken]
        PARSEMARKDOWNTONODES[parseMarkdownToNodes]
        NODESTOTEXT[nodesToText]
        GETPLAINTEXT[getPlainText]
        PARSEMARKDOWNWITHMARKERS[parseMarkdownWithMarkers]
    end
    
    subgraph "Functions"
        PARSEMARKDOWNTONODES[parseMarkdownToNodes()]
        NODESTOTEXT[nodesToText()]
        GETPLAINTEXT[getPlainText()]
        PARSEMARKDOWNWITHMARKERS[parseMarkdownWithMarkers()]
    end
    
    subgraph "Interfaces"
        MARKDOWNNODE[MarkdownNode]
        PARSEDCONTENT[ParsedContent]
        MARKDOWNTOKEN[MarkdownToken]
        MATCH[Match]
        MATCH[Match]
    end
```

## Exports

- **MarkdownNode** - No description
- **ParsedContent** - No description
- **MarkdownToken** - No description
- **parseMarkdownToNodes** - No description
- **nodesToText** - No description
- **getPlainText** - No description
- **parseMarkdownWithMarkers** - No description

## Functions

### `parseMarkdownToNodes(text: string)`

No description available.

**Parameters:**
- `text: string`

**Returns:** Unknown

```typescript
export function parseMarkdownToNodes(text: string): MarkdownNode[] {
```

### `nodesToText(nodes: MarkdownNode[])`

No description available.

**Parameters:**
- `nodes: MarkdownNode[]`

**Returns:** Unknown

```typescript
export function nodesToText(nodes: MarkdownNode[]): string {
```

### `getPlainText(nodes: MarkdownNode[])`

No description available.

**Parameters:**
- `nodes: MarkdownNode[]`

**Returns:** Unknown

```typescript
export function getPlainText(nodes: MarkdownNode[]): string {
```

### `parseMarkdownWithMarkers(text: string)`

No description available.

**Parameters:**
- `text: string`

**Returns:** Unknown

```typescript
export function parseMarkdownWithMarkers(text: string): MarkdownToken[] {
```




## Interfaces

### MarkdownNode

No description available.

```typescript
export interface MarkdownNode {
  type: 'text' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'codeblock' | 'emoji' | 'newline';
  content: string;
  language?: string; // For code blocks
  emojiData?: { name: string; url: string; id: string }
```

### ParsedContent

No description available.

```typescript
export interface ParsedContent {
  text: string;
  nodes: MarkdownNode[];
}
```

### MarkdownToken

No description available.

```typescript
export interface MarkdownToken {
  type: 'text' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'codeblock' | 'emoji';
  content: string;
  language?: string; // For code blocks
  raw?: string; // The original text including markers
}
```

### Match

No description available.

```typescript
interface Match {
    type: keyof typeof PATTERNS;
    match: RegExpMatchArray;
    start: number;
    end: number;
    content: string;
    language?: string;
  }
```

### Match

No description available.

```typescript
interface Match {
    type: keyof typeof PATTERNS | 'incomplete_codeblock';
    match: RegExpMatchArray;
    start: number;
    end: number;
    content: string;
    language?: string;
    raw: string;
    isIncomplete?: boolean;
  }
```




## Constants

### PATTERNS

No description available.

```typescript
const PATTERNS = {
```


## Source Code Insights

**File Size:** 10786 characters
**Lines of Code:** 384
**Imports:** 0

## Usage Example

```typescript
import { MarkdownNode, ParsedContent, MarkdownToken, parseMarkdownToNodes, nodesToText, getPlainText, parseMarkdownWithMarkers } from '@/utils/markdownParser.ts'

// Example usage
parseMarkdownToNodes()
```

---

*This documentation was automatically generated from the source code.*