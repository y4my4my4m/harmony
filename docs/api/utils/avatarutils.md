# avatarUtils Utility

**File:** `src/utils/avatarUtils.ts`

## Overview

```mermaid
graph TB
    subgraph "avatarUtils Utility"
        GETAVATARURL[getAvatarUrl]
        NORMALIZEAVATARFORSTORAGE[normalizeAvatarForStorage]
    end
    
    subgraph "Functions"
        GETAVATARURL[getAvatarUrl()]
        NORMALIZEAVATARFORSTORAGE[normalizeAvatarForStorage()]
    end
    
    
```

## Exports

- **getAvatarUrl** - No description
- **normalizeAvatarForStorage** - No description

## Functions

### `getAvatarUrl(avatarUrl: string | null | undefined)`

No description available.

**Parameters:**
- `avatarUrl: string | null | undefined`

**Returns:** Unknown

```typescript
export function getAvatarUrl(avatarUrl: string | null | undefined): string {
```

### `normalizeAvatarForStorage(avatarUrl: string | null | undefined)`

No description available.

**Parameters:**
- `avatarUrl: string | null | undefined`

**Returns:** Unknown

```typescript
export function normalizeAvatarForStorage(avatarUrl: string | null | undefined): string | null {
```










## Source Code Insights

**File Size:** 2219 characters
**Lines of Code:** 64
**Imports:** 1

## Usage Example

```typescript
import { getAvatarUrl, normalizeAvatarForStorage } from '@/utils/avatarUtils.ts'

// Example usage
getAvatarUrl()
```

---

*This documentation was automatically generated from the source code.*