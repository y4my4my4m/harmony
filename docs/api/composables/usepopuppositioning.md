# usePopupPositioning Composable

**File:** `src/composables/usePopupPositioning.ts`

## Overview

```mermaid
graph TB
    subgraph "usePopupPositioning Composable"
        POPUPPOSITION[PopupPosition]
        POPUPPOSITIONKEY[PopupPositionKey]
        POPUPDIMENSIONS[PopupDimensions]
        POPUPPOSITIONRESULT[PopupPositionResult]
        USEPOPUPPOSITIONINGOPTIONS[UsePopupPositioningOptions]
        CALCULATEPOPUPPOSITION[calculatePopupPosition]
        USEPOPUPPOSITIONING[usePopupPositioning]
    end
    
    subgraph "Functions"
        CALCULATEPOPUPPOSITION[calculatePopupPosition()]
        USEPOPUPPOSITIONING[usePopupPositioning()]
        FITSINVIEWPORT[fitsInViewport()]
        UPDATEPOSITION[updatePosition()]
    end
    
    subgraph "Interfaces"
        POPUPDIMENSIONS[PopupDimensions]
        POPUPPOSITIONRESULT[PopupPositionResult]
        USEPOPUPPOSITIONINGOPTIONS[UsePopupPositioningOptions]
    end
```

## Exports

- **PopupPosition** - No description
- **PopupPositionKey** - No description
- **PopupDimensions** - No description
- **PopupPositionResult** - No description
- **UsePopupPositioningOptions** - No description
- **calculatePopupPosition** - No description
- **usePopupPositioning** - No description

## Functions

### `calculatePopupPosition(triggerElement: HTMLElement, popupDimensions: PopupDimensions, options: UsePopupPositioningOptions = {})`

No description available.

**Parameters:**
- `triggerElement: HTMLElement`
- `popupDimensions: PopupDimensions`
- `options: UsePopupPositioningOptions = {}`

**Returns:** Unknown

```typescript
export function calculatePopupPosition(
  triggerElement: HTMLElement,
  popupDimensions: PopupDimensions,
  options: UsePopupPositioningOptions = {}
): PopupPositionResult {
```

### `usePopupPositioning(triggerElement: Ref<HTMLElement | null>, popupDimensions: PopupDimensions, options: UsePopupPositioningOptions = {})`

No description available.

**Parameters:**
- `triggerElement: Ref<HTMLElement | null>`
- `popupDimensions: PopupDimensions`
- `options: UsePopupPositioningOptions = {}`

**Returns:** Unknown

```typescript
export function usePopupPositioning(
  triggerElement: Ref<HTMLElement | null>,
  popupDimensions: PopupDimensions,
  options: UsePopupPositioningOptions = {}
) {
```

### `fitsInViewport(pos: PopupPositionResult)`

No description available.

**Parameters:**
- `pos: PopupPositionResult`

**Returns:** Unknown

```typescript
const fitsInViewport = (pos: PopupPositionResult) =>
```

### `updatePosition()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const updatePosition = () =>
```




## Interfaces

### PopupDimensions

No description available.

```typescript
export interface PopupDimensions {
  width: number;
  height: number;
}
```

### PopupPositionResult

No description available.

```typescript
export interface PopupPositionResult {
  x: number;
  y: number;
  actualPosition: PopupPositionKey;
}
```

### UsePopupPositioningOptions

No description available.

```typescript
export interface UsePopupPositioningOptions {
  position?: PopupPosition;
  offset?: number;
  viewport?: {
    padding: number;
  }
```


## Type Definitions

### PopupPosition

No description available.

```typescript
export type PopupPosition = 'above' | 'below' | 'left' | 'right' | 'auto'
```

### PopupPositionKey

No description available.

```typescript
export type PopupPositionKey = 'above' | 'below' | 'left' | 'right'
```




## Source Code Insights

**File Size:** 4868 characters
**Lines of Code:** 166
**Imports:** 1

## Usage Example

```typescript
import { PopupPosition, PopupPositionKey, PopupDimensions, PopupPositionResult, UsePopupPositioningOptions, calculatePopupPosition, usePopupPositioning } from '@/composables/usePopupPositioning.ts'

// Example usage
calculatePopupPosition()
```

---

*This documentation was automatically generated from the source code.*