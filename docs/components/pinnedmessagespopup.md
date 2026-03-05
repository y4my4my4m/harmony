# PinnedMessagesPopup

A Vue component.

**File:** `src/components/PinnedMessagesPopup.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[PinnedMessagesPopup]
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
| `conversationId` | `string` | `undefined` | ❌ | No description |

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



#### `conversationId`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |
| `jump-to-message` | `string` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `jump-to-message`

No description available.

**Parameters:** `string`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <PinnedMessagesPopup
    :isVisible="true"
    @close="handleClose"
    @jump-to-message="handleJumpToMessage" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleJumpToMessage = (data: string) => {
  // Handle jump-to-message event
}
</script>
```



## File Location

`src/components/PinnedMessagesPopup.vue`

---

*This documentation was automatically generated from the component source code.*