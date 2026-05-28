# MobileVoiceChannelPreview

A Vue component.

**File:** `src/components/voice/MobileVoiceChannelPreview.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[MobileVoiceChannelPreview]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isVisible` | `boolean` | `undefined` | ✅ | No description |
| `channelId` | `string` | `undefined` | ✅ | No description |
| `channelName` | `string` | `undefined` | ✅ | No description |
| `participants` | `Array` | `undefined` | ✅ | No description |

### Props Details

#### `isVisible`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `channelId`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `channelName`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `participants`

No description available.

- **Type:** `Array`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |
| `join` | `boolean` | No description |
| `open-chat` | `unknown` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `join`

No description available.

**Parameters:** `boolean`



#### `open-chat`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <MobileVoiceChannelPreview
    :isVisible="true"
    :channelId=""example""
    :channelName=""example""
    :participants="[]"
    @close="handleClose"
    @join="handleJoin"
    @open-chat="handleOpenChat" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleJoin = (data: boolean) => {
  // Handle join event
}

const handleOpenChat = (data: unknown) => {
  // Handle open-chat event
}
</script>
```



## File Location

`src/components/voice/MobileVoiceChannelPreview.vue`

---

*This documentation was automatically generated from the component source code.*