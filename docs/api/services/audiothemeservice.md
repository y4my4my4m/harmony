# AudioThemeService Service

**File:** `src/services/AudioThemeService.ts`

## Overview

```mermaid
graph TB
    subgraph "AudioThemeService Service"
        AUDIOTHEMESERVICE[AudioThemeService]
        AUDIOTHEMESERVICE[audioThemeService]
    end
    
    subgraph "Functions"
        CLEANUP[cleanup()]
        ONLOAD[onLoad()]
        ONERROR[onError()]
    end
    
    
```

## Exports

- **AudioThemeService** - No description
- **audioThemeService** - No description

## Functions

### `cleanup()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const cleanup = () =>
```

### `onLoad()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const onLoad = () =>
```

### `onError()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const onError = () =>
```


## Classes

### AudioThemeService

No description available.

**Methods:**
None

**Properties:**
- `instance`
- `null`
- `audioCache`
- `audioQueue`
- `settings`
- `AudioThemeSettings`
- `selectedTheme`
- `volume`
- `lastUpdated`








## Source Code Insights

**File Size:** 18891 characters
**Lines of Code:** 602
**Imports:** 1

## Usage Example

```typescript
import { AudioThemeService, audioThemeService } from '@/services/AudioThemeService.ts'

// Example usage
cleanup()
```

---

*This documentation was automatically generated from the source code.*