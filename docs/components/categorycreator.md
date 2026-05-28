# CategoryCreator

A Vue component.

**File:** `src/components/CategoryCreator.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[CategoryCreator]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

This component has no props.

## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `showCategoryCreator` | `boolean` | No description |
| `createCategory` | `string` | No description |

### Event Details

#### `showCategoryCreator`

No description available.

**Parameters:** `boolean`



#### `createCategory`

No description available.

**Parameters:** `string`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <CategoryCreator
    @showCategoryCreator="handleShowCategoryCreator"
    @createCategory="handleCreateCategory" />
</template>

<script setup lang="ts">
const handleShowCategoryCreator = (data: boolean) => {
  // Handle showCategoryCreator event
}

const handleCreateCategory = (data: string) => {
  // Handle createCategory event
}
</script>
```



## File Location

`src/components/CategoryCreator.vue`

---

*This documentation was automatically generated from the component source code.*