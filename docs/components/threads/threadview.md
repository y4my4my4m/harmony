# ThreadView

A Vue component.

**File:** `src/components/threads/ThreadView.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ThreadView]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isVisible` | `boolean` | `undefined` | ✅ | No description |
| `threadId` | `string` | `undefined` | ❌ | No description |
| `initialThread` | `ThreadWithDetails` | `undefined` | ❌ | No description |
| `draftParentMessage` | `union` | `undefined` | ❌ | No description |
| `channelId` | `string` | `undefined` | ❌ | No description |

### Props Details

#### `isVisible`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `threadId`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `initialThread`

No description available.

- **Type:** `ThreadWithDetails`
- **Required:** No
- **Default:** `undefined`



#### `draftParentMessage`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `undefined`



#### `channelId`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |
| `thread-updated` | `ThreadWithDetails` | No description |
| `thread-created` | `ThreadWithDetails` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `thread-updated`

No description available.

**Parameters:** `ThreadWithDetails`



#### `thread-created`

No description available.

**Parameters:** `ThreadWithDetails`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ThreadView
    :isVisible="true"
    @close="handleClose"
    @thread-updated="handleThreadUpdated"
    @thread-created="handleThreadCreated" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleThreadUpdated = (data: ThreadWithDetails) => {
  // Handle thread-updated event
}

const handleThreadCreated = (data: ThreadWithDetails) => {
  // Handle thread-created event
}
</script>
```



## File Location

`src/components/threads/ThreadView.vue`

---

*This documentation was automatically generated from the component source code.*