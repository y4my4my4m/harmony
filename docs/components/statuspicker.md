# StatusPicker

A Vue component.

**File:** `src/components/StatusPicker.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[StatusPicker]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isVisible` | `boolean` | `undefined` | ✅ | No description |
| `currentStatus` | `union` | `undefined` | ❌ | No description |

### Props Details

#### `isVisible`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `currentStatus`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |
| `status-updated` | `union` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `status-updated`

No description available.

**Parameters:** `union`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <StatusPicker
    :isVisible="true"
    @close="handleClose"
    @status-updated="handleStatusUpdated" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleStatusUpdated = (data: union) => {
  // Handle status-updated event
}
</script>
```



## File Location

`src/components/StatusPicker.vue`

---

*This documentation was automatically generated from the component source code.*