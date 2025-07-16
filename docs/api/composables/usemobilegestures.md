# useMobileGestures Composable

**File:** `src/composables/useMobileGestures.ts`

## Overview

```mermaid
graph TB
    subgraph "useMobileGestures Composable"
        USEMOBILEGESTURES[useMobileGestures]
    end
    
    subgraph "Functions"
        USEMOBILEGESTURES[useMobileGestures()]
        HANDLETOUCHSTART[handleTouchStart()]
        HANDLETOUCHMOVE[handleTouchMove()]
        HANDLETOUCHEND[handleTouchEnd()]
        RESETTOUCHSTATE[resetTouchState()]
    end
    
    subgraph "Interfaces"
        TOUCHSTATE[TouchState]
        SWIPECONFIG[SwipeConfig]
    end
```

## Exports

- **useMobileGestures** - No description

## Functions

### `useMobileGestures()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
export function useMobileGestures() {
```

### `handleTouchStart(event: TouchEvent, isMobile: boolean)`

No description available.

**Parameters:**
- `event: TouchEvent`
- `isMobile: boolean`

**Returns:** Unknown

```typescript
const handleTouchStart = (event: TouchEvent, isMobile: boolean) =>
```

### `handleTouchMove(event: TouchEvent, isMobile: boolean, hasOpenSidebars: boolean)`

No description available.

**Parameters:**
- `event: TouchEvent`
- `isMobile: boolean`
- `hasOpenSidebars: boolean`

**Returns:** Unknown

```typescript
const handleTouchMove = (event: TouchEvent, isMobile: boolean, hasOpenSidebars: boolean) =>
```

### `handleTouchEnd(event: TouchEvent, isMobile: boolean, callbacks: {
      onSwipeRight: ()`

No description available.

**Parameters:**
- `event: TouchEvent`
- `isMobile: boolean`
- `callbacks: {
      onSwipeRight: (`

**Returns:** Unknown

```typescript
const handleTouchEnd = (
    event: TouchEvent, 
    isMobile: boolean,
    callbacks: {
      onSwipeRight: () =>
```

### `resetTouchState()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const resetTouchState = () =>
```




## Interfaces

### TouchState

No description available.

```typescript
interface TouchState {
  startX: number
  startY: number
  currentX: number
  currentY: number
  isDragging: boolean
  initialDirection: 'horizontal' | 'vertical' | null
  isEdgeSwipe: boolean
  startTime: number
}
```

### SwipeConfig

No description available.

```typescript
interface SwipeConfig {
  swipeThreshold: number
  directionThreshold: number
  edgeZone: number
  velocityThreshold: number
}
```






## Source Code Insights

**File Size:** 4428 characters
**Lines of Code:** 161
**Imports:** 1

## Usage Example

```typescript
import { useMobileGestures } from '@/composables/useMobileGestures.ts'

// Example usage
useMobileGestures()
```

---

*This documentation was automatically generated from the source code.*