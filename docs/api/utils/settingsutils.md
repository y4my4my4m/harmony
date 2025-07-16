# settingsUtils Utility

**File:** `src/utils/settingsUtils.ts`

## Overview

```mermaid
graph TB
    subgraph "settingsUtils Utility"
        SETTINGSSECTION[SettingsSection]
        GETSETTINGSROUTE[getSettingsRoute]
        GETSETTINGSPATH[getSettingsPath]
        ISVALIDSETTINGSSECTION[isValidSettingsSection]
        GETDEFAULTSETTINGSSECTION[getDefaultSettingsSection]
        CREATESETTINGSNAVIGATOR[createSettingsNavigator]
    end
    
    subgraph "Functions"
        GETSETTINGSROUTE[getSettingsRoute()]
        GETSETTINGSPATH[getSettingsPath()]
        ISVALIDSETTINGSSECTION[isValidSettingsSection()]
        GETDEFAULTSETTINGSSECTION[getDefaultSettingsSection()]
        CREATESETTINGSNAVIGATOR[createSettingsNavigator()]
    end
    
    
```

## Exports

- **SettingsSection** - No description
- **getSettingsRoute** - No description
- **getSettingsPath** - No description
- **isValidSettingsSection** - No description
- **getDefaultSettingsSection** - No description
- **createSettingsNavigator** - No description

## Functions

### `getSettingsRoute(section: SettingsSection)`

No description available.

**Parameters:**
- `section: SettingsSection`

**Returns:** Unknown

```typescript
export function getSettingsRoute(section: SettingsSection): RouteLocationRaw {
```

### `getSettingsPath(section: SettingsSection)`

No description available.

**Parameters:**
- `section: SettingsSection`

**Returns:** Unknown

```typescript
export function getSettingsPath(section: SettingsSection): string {
```

### `isValidSettingsSection(section: string)`

No description available.

**Parameters:**
- `section: string`

**Returns:** Unknown

```typescript
export function isValidSettingsSection(section: string): section is SettingsSection {
```

### `getDefaultSettingsSection()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
export function getDefaultSettingsSection(): SettingsSection {
```

### `createSettingsNavigator(router: any)`

No description available.

**Parameters:**
- `router: any`

**Returns:** Unknown

```typescript
export function createSettingsNavigator(router: any) {
```






## Type Definitions

### SettingsSection

No description available.

```typescript
export type SettingsSection = 
  | 'account' 
```




## Source Code Insights

**File Size:** 2038 characters
**Lines of Code:** 90
**Imports:** 1

## Usage Example

```typescript
import { SettingsSection, getSettingsRoute, getSettingsPath, isValidSettingsSection, getDefaultSettingsSection, createSettingsNavigator } from '@/utils/settingsUtils.ts'

// Example usage
getSettingsRoute()
```

---

*This documentation was automatically generated from the source code.*