# ServerCardSkeleton

A Vue component.

**File:** `src/components/common/ServerCardSkeleton.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ServerCardSkeleton]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `count` | `number` | `6` | ❌ | No description |

### Props Details

#### `count`

No description available.

- **Type:** `number`
- **Required:** No
- **Default:** `6`




## Events

This component emits no events.

## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ServerCardSkeleton
     />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/common/ServerCardSkeleton.vue`

---

*This documentation was automatically generated from the component source code.*