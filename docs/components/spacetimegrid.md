# SpaceTimeGrid

A Vue component.

**File:** `src/components/SpaceTimeGrid.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[SpaceTimeGrid]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `width` | `number` | `undefined` | ✅ | No description |
| `height` | `number` | `undefined` | ✅ | No description |
| `avatars` | `Array` | `undefined` | ✅ | No description |

### Props Details

#### `width`

No description available.

- **Type:** `number`
- **Required:** Yes
- **Default:** `undefined`



#### `height`

No description available.

- **Type:** `number`
- **Required:** Yes
- **Default:** `undefined`



#### `avatars`

No description available.

- **Type:** `Array`
- **Required:** Yes
- **Default:** `undefined`




## Events

This component emits no events.

## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <SpaceTimeGrid
    :width="42"
    :height="42"
    :avatars="[]" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/SpaceTimeGrid.vue`

---

*This documentation was automatically generated from the component source code.*