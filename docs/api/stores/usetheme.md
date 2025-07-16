# useTheme Store

**File:** `src/stores/useTheme.ts`

## Overview

```mermaid
graph TB
    subgraph "useTheme Store"
        USETHEMESTORE[useThemeStore]
    end
    
    
    
    subgraph "Interfaces"
        THEMESTATE[ThemeState]
    end
```

## Exports

- **useThemeStore** - No description





## Interfaces

### ThemeState

No description available.

```typescript
interface ThemeState {
  // Audio themes
  audioThemes: AudioTheme[]
  currentAudioTheme: string
  audioVolume: number
  
  // State management
  isInitialized: boolean
  isLoading: boolean
  isPreloading: boolean
  preloadingTheme: string | null
  
  // Error handling
  lastError: string | null
  
  // Visual themes (future expansion)
  // visualTheme: string
  // customColors: Record<string, string>
}
```






## Source Code Insights

**File Size:** 9423 characters
**Lines of Code:** 357
**Imports:** 3

## Usage Example

```typescript
import { useThemeStore } from '@/stores/useTheme.ts'

// Example usage
// Use the exported functionality
```

---

*This documentation was automatically generated from the source code.*