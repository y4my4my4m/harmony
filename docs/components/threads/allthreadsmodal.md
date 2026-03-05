# AllThreadsModal

A Vue component.

**File:** `src/components/threads/AllThreadsModal.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[AllThreadsModal]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isVisible` | `boolean` | `undefined` | ✅ | No description |
| `channelId` | `string` | `undefined` | ❌ | No description |
| `serverId` | `string` | `undefined` | ❌ | No description |

### Props Details

#### `isVisible`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `channelId`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `serverId`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |
| `select-thread` | `ThreadWithDetails` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `select-thread`

No description available.

**Parameters:** `ThreadWithDetails`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <AllThreadsModal
    :isVisible="true"
    @close="handleClose"
    @select-thread="handleSelectThread" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleSelectThread = (data: ThreadWithDetails) => {
  // Handle select-thread event
}
</script>
```



## File Location

`src/components/threads/AllThreadsModal.vue`

---

*This documentation was automatically generated from the component source code.*