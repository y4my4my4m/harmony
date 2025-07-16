# PWAManager Service

**File:** `src/services/PWAManager.ts`

## Overview

```mermaid
graph TB
    subgraph "PWAManager Service"
        PWAINSTALLPROMPT[PWAInstallPrompt]
        PWACAPABILITIES[PWACapabilities]
        PWAMANAGER[PWAManager]
        PWAMANAGER[pwaManager]
    end
    
    subgraph "Functions"
        HANDLEORIENTATIONCHANGE[handleOrientationChange()]
        CREATEREFRESHINDICATOR[createRefreshIndicator()]
        UPDATEREFRESHINDICATOR[updateRefreshIndicator()]
        HIDEREFRESHINDICATOR[hideRefreshIndicator()]
    end
    
    subgraph "Interfaces"
        PWAINSTALLPROMPT[PWAInstallPrompt]
        PWACAPABILITIES[PWACapabilities]
    end
```

## Exports

- **PWAInstallPrompt** - No description
- **PWACapabilities** - No description
- **PWAManager** - No description
- **pwaManager** - No description

## Functions

### `handleOrientationChange()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const handleOrientationChange = () =>
```

### `createRefreshIndicator()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const createRefreshIndicator = () =>
```

### `updateRefreshIndicator(progress: number)`

No description available.

**Parameters:**
- `progress: number`

**Returns:** Unknown

```typescript
const updateRefreshIndicator = (progress: number) =>
```

### `hideRefreshIndicator()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const hideRefreshIndicator = () =>
```


## Classes

### PWAManager

No description available.

**Methods:**
None

**Properties:**
- `instance`
- `installPrompt`
- `null`
- `capabilities`
- `PWACapabilities`
- `canInstall`
- `isInstalled`
- `isStandalone`
- `supportsNotifications`
- `supportsBackgroundSync`
- `supportsShare`
- `supportsBadging`
- `supportsShortcuts`


## Interfaces

### PWAInstallPrompt

No description available.

```typescript
export interface PWAInstallPrompt {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }
```

### PWACapabilities

No description available.

```typescript
export interface PWACapabilities {
  canInstall: boolean
  isInstalled: boolean
  isStandalone: boolean
  supportsNotifications: boolean
  supportsBackgroundSync: boolean
  supportsShare: boolean
  supportsBadging: boolean
  supportsShortcuts: boolean
}
```






## Source Code Insights

**File Size:** 19221 characters
**Lines of Code:** 665
**Imports:** 0

## Usage Example

```typescript
import { PWAInstallPrompt, PWACapabilities, PWAManager, pwaManager } from '@/services/PWAManager.ts'

// Example usage
handleOrientationChange()
```

---

*This documentation was automatically generated from the source code.*