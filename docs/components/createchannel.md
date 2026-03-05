# CreateChannel

A Vue component.

**File:** `src/components/CreateChannel.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[CreateChannel]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `serverId` | `string` | `undefined` | ✅ | No description |
| `show` | `boolean` | `undefined` | ✅ | No description |
| `categoryId` | `union` | `undefined` | ❌ | No description |

### Props Details

#### `serverId`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `show`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `categoryId`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |
| `channelCreated` | `any` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `channelCreated`

No description available.

**Parameters:** `any`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <CreateChannel
    :serverId=""example""
    :show="true"
    @close="handleClose"
    @channelCreated="handleChannelCreated" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleChannelCreated = (data: any) => {
  // Handle channelCreated event
}
</script>
```



## File Location

`src/components/CreateChannel.vue`

---

*This documentation was automatically generated from the component source code.*