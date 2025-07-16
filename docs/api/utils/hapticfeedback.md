# hapticFeedback Utility

**File:** `src/utils/hapticFeedback.ts`

## Overview

```mermaid
graph TB
    subgraph "hapticFeedback Utility"
        HAPTICPATTERN[HapticPattern]
        HAPTICOPTIONS[HapticOptions]
        HAPTICMANAGER[hapticManager]
        VHAPTIC[vHaptic]
    end
    
    subgraph "Functions"
        HANDLETRIGGER[handleTrigger()]
    end
    
    subgraph "Interfaces"
        HAPTICOPTIONS[HapticOptions]
    end
```

## Exports

- **HapticPattern** - No description
- **HapticOptions** - No description
- **hapticManager** - No description
- **vHaptic** - No description

## Functions

### `handleTrigger()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const handleTrigger = () =>
```


## Classes

### HapticFeedbackManager

No description available.

**Methods:**
- `constructor`

**Properties:**
- `isEnabled`
- `boolean`
- `isSupported`
- `boolean`


## Interfaces

### HapticOptions

No description available.

```typescript
export interface HapticOptions {
  pattern?: HapticPattern
  duration?: number
  intensity?: number
  enabled?: boolean
}
```


## Type Definitions

### HapticPattern

No description available.

```typescript
export type HapticPattern = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'selection' | 'impact' | 'notification'
```




## Source Code Insights

**File Size:** 4405 characters
**Lines of Code:** 176
**Imports:** 0

## Usage Example

```typescript
import { HapticPattern, HapticOptions, hapticManager, vHaptic } from '@/utils/hapticFeedback.ts'

// Example usage
handleTrigger()
```

---

*This documentation was automatically generated from the source code.*