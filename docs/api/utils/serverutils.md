# serverUtils Utility

**File:** `src/utils/serverUtils.ts`

## Overview

```mermaid
graph TB
    subgraph "serverUtils Utility"
        GETSERVERICONURL[getServerIconUrl]
        NORMALIZESERVERFORSTORAGE[normalizeServerForStorage]
    end
    
    subgraph "Functions"
        GETSERVERICONURL[getServerIconUrl()]
        NORMALIZESERVERFORSTORAGE[normalizeServerForStorage()]
    end
    
    
```

## Exports

- **getServerIconUrl** - No description
- **normalizeServerForStorage** - No description

## Functions

### `getServerIconUrl(serverUrl: string | null | undefined)`

No description available.

**Parameters:**
- `serverUrl: string | null | undefined`

**Returns:** Unknown

```typescript
export function getServerIconUrl(serverUrl: string | null | undefined): string {
```

### `normalizeServerForStorage(serverUrl: string | null | undefined)`

No description available.

**Parameters:**
- `serverUrl: string | null | undefined`

**Returns:** Unknown

```typescript
export function normalizeServerForStorage(serverUrl: string | null | undefined): string | null {
```










## Source Code Insights

**File Size:** 2182 characters
**Lines of Code:** 63
**Imports:** 1

## Usage Example

```typescript
import { getServerIconUrl, normalizeServerForStorage } from '@/utils/serverUtils.ts'

// Example usage
getServerIconUrl()
```

---

*This documentation was automatically generated from the source code.*