# useDebounce Composable

**File:** `src/composables/useDebounce.ts`

## Overview

```mermaid
graph TB
    subgraph "useDebounce Composable"
        USEDEBOUNCEOPTIONS[UseDebounceOptions]
        USEDEBOUNCE[useDebounce]
        USEDEBOUNCEDSEARCH[useDebouncedSearch]
    end
    
    subgraph "Functions"
        USEDEBOUNCEDSEARCH[useDebouncedSearch()]
        EXECUTECALLBACK[executeCallback()]
        CANCEL[cancel()]
    end
    
    subgraph "Interfaces"
        USEDEBOUNCEOPTIONS[UseDebounceOptions]
    end
```

## Exports

- **UseDebounceOptions** - No description
- **useDebounce** - No description
- **useDebouncedSearch** - No description

## Functions

### `useDebouncedSearch(searchQuery: Ref<string>, searchCallback: (query: string)`

No description available.

**Parameters:**
- `searchQuery: Ref<string>`
- `searchCallback: (query: string`

**Returns:** Unknown

```typescript
export function useDebouncedSearch(
  searchQuery: Ref<string>,
  searchCallback: (query: string) => void | Promise<void>,
  delay = 300
) {
```

### `executeCallback(value: T)`

No description available.

**Parameters:**
- `value: T`

**Returns:** Unknown

```typescript
const executeCallback = async (value: T) =>
```

### `cancel()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const cancel = () =>
```




## Interfaces

### UseDebounceOptions

No description available.

```typescript
export interface UseDebounceOptions {
  delay?: number
  immediate?: boolean
}
```






## Source Code Insights

**File Size:** 1644 characters
**Lines of Code:** 84
**Imports:** 1

## Usage Example

```typescript
import { UseDebounceOptions, useDebounce, useDebouncedSearch } from '@/composables/useDebounce.ts'

// Example usage
useDebouncedSearch()
```

---

*This documentation was automatically generated from the source code.*