# syntaxHighlighter Utility

**File:** `src/utils/syntaxHighlighter.ts`

## Overview

```mermaid
graph TB
    subgraph "syntaxHighlighter Utility"
        SYNTAXTOKEN[SyntaxToken]
        HIGHLIGHTSYNTAX[highlightSyntax]
        GETSUPPORTEDLANGUAGES[getSupportedLanguages]
    end
    
    subgraph "Functions"
        HIGHLIGHTSYNTAX[highlightSyntax()]
        GETSUPPORTEDLANGUAGES[getSupportedLanguages()]
    end
    
    subgraph "Interfaces"
        SYNTAXTOKEN[SyntaxToken]
    end
```

## Exports

- **SyntaxToken** - No description
- **highlightSyntax** - No description
- **getSupportedLanguages** - No description

## Functions

### `highlightSyntax(code: string, language: string = 'text')`

No description available.

**Parameters:**
- `code: string`
- `language: string = 'text'`

**Returns:** Unknown

```typescript
export function highlightSyntax(code: string, language: string = 'text'): SyntaxToken[] {
```

### `getSupportedLanguages()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
export function getSupportedLanguages(): string[] {
```




## Interfaces

### SyntaxToken

No description available.

```typescript
export interface SyntaxToken {
  type: 'keyword' | 'string' | 'number' | 'comment' | 'operator' | 'punctuation' | 'function' | 'variable' | 'property' | 'text';
  content: string;
  className: string;
}
```






## Source Code Insights

**File Size:** 7195 characters
**Lines of Code:** 183
**Imports:** 0

## Usage Example

```typescript
import { SyntaxToken, highlightSyntax, getSupportedLanguages } from '@/utils/syntaxHighlighter.ts'

// Example usage
highlightSyntax()
```

---

*This documentation was automatically generated from the source code.*