# ChannelContextMenu

A Vue component.

**File:** `src/components/ChannelContextMenu.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ChannelContextMenu]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isVisible` | `boolean` | `undefined` | ✅ | No description |
| `position` | `{ x: number; y: number }` | `undefined` | ✅ | No description |
| `channel` | `union` | `undefined` | ✅ | No description |

### Props Details

#### `isVisible`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `position`

No description available.

- **Type:** `{ x: number; y: number }`
- **Required:** Yes
- **Default:** `undefined`



#### `channel`

No description available.

- **Type:** `union`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | unknown | No description |
| `invite-users` | unknown | No description |
| `edit-channel` | Channel | No description |
| `delete-channel` | Channel | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `invite-users`

No description available.

**Parameters:** `unknown`



#### `edit-channel`

No description available.

**Parameters:** `Channel`



#### `delete-channel`

No description available.

**Parameters:** `Channel`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ChannelContextMenu
    :isVisible="true"
    :position="undefined"
    :channel="undefined"
    @close="handleClose"
    @invite-users="handleInvite-users"
    @edit-channel="handleEdit-channel"
    @delete-channel="handleDelete-channel" />
</template>

<script setup lang="ts">
const handleClose = (data) => {
  // Handle close event
}

const handleInvite-users = (data) => {
  // Handle invite-users event
}

const handleEdit-channel = (Channel) => {
  // Handle edit-channel event
}

const handleDelete-channel = (Channel) => {
  // Handle delete-channel event
}
</script>
```



## File Location

`src/components/ChannelContextMenu.vue`

---

*This documentation was automatically generated from the component source code.*