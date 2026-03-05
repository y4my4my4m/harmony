# GroupSettingsModal

A Vue component.

**File:** `src/components/dm/GroupSettingsModal.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[GroupSettingsModal]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `show` | `boolean` | `undefined` | ✅ | No description |
| `conversation` | `DMConversation` | `undefined` | ✅ | No description |
| `conversationId` | `string` | `undefined` | ✅ | No description |
| `participants` | `Array` | `undefined` | ✅ | No description |

### Props Details

#### `show`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `conversation`

No description available.

- **Type:** `DMConversation`
- **Required:** Yes
- **Default:** `undefined`



#### `conversationId`

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
| `updated` | `unknown` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `updated`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <GroupSettingsModal
    :show="true"
    :conversation="undefined"
    :conversationId=""example""
    :participants="[]"
    @close="handleClose"
    @updated="handleUpdated" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleUpdated = (data: unknown) => {
  // Handle updated event
}
</script>
```



## File Location

`src/components/dm/GroupSettingsModal.vue`

---

*This documentation was automatically generated from the component source code.*