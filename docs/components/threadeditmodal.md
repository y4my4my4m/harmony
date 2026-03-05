# ThreadEditModal

A Vue component.

**File:** `src/components/ThreadEditModal.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ThreadEditModal]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `show` | `boolean` | `undefined` | ✅ | No description |
| `thread` | `union` | `undefined` | ✅ | No description |

### Props Details

#### `show`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `thread`

No description available.

- **Type:** `union`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |
| `updated` | `Thread` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `updated`

No description available.

**Parameters:** `Thread`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ThreadEditModal
    :show="true"
    :thread="undefined"
    @close="handleClose"
    @updated="handleUpdated" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleUpdated = (data: Thread) => {
  // Handle updated event
}
</script>
```



## File Location

`src/components/ThreadEditModal.vue`

---

*This documentation was automatically generated from the component source code.*