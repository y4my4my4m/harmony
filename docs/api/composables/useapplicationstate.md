# useApplicationState Composable

**File:** `src/composables/useApplicationState.ts`

## Overview

```mermaid
graph TB
    subgraph "useApplicationState Composable"
        USEAPPLICATIONSTATE[useApplicationState]
        APPLICATIONSTATE[applicationState]
    end
    
    subgraph "Functions"
        USEAPPLICATIONSTATE[useApplicationState()]
        STARTINITIALIZATION[startInitialization()]
        COMPLETEINITIALIZATION[completeInitialization()]
        UPDATESERVERCOUNT[updateServerCount()]
        SETINITIALIZATIONERROR[setInitializationError()]
        RESETAPPLICATIONSTATE[resetApplicationState()]
        GETEARLYSTATE[getEarlyState()]
    end
    
    
```

## Exports

- **useApplicationState** - No description
- **applicationState** - No description

## Functions

### `useApplicationState()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
export function useApplicationState() {
```

### `startInitialization()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
async function startInitialization(): Promise<void> {
```

### `completeInitialization(serverCount: number)`

No description available.

**Parameters:**
- `serverCount: number`

**Returns:** Unknown

```typescript
async function completeInitialization(serverCount: number): Promise<void> {
```

### `updateServerCount(count: number)`

No description available.

**Parameters:**
- `count: number`

**Returns:** Unknown

```typescript
function updateServerCount(count: number): void {
```

### `setInitializationError(error: string | null)`

No description available.

**Parameters:**
- `error: string | null`

**Returns:** Unknown

```typescript
function setInitializationError(error: string | null): void {
```

### `resetApplicationState()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
async function resetApplicationState(): Promise<void> {
```

### `getEarlyState()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
function getEarlyState() {
```










## Source Code Insights

**File Size:** 4660 characters
**Lines of Code:** 167
**Imports:** 2

## Usage Example

```typescript
import { useApplicationState, applicationState } from '@/composables/useApplicationState.ts'

// Example usage
useApplicationState()
```

---

*This documentation was automatically generated from the source code.*