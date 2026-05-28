# VoiceChannelUserList

A Vue component.

**File:** `src/components/voice/VoiceChannelUserList.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[VoiceChannelUserList]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `userIds` | `Array` | `undefined` | ✅ | No description |
| `callStartTime` | `union` | `undefined` | ❌ | No description |

### Props Details

#### `userIds`

No description available.

- **Type:** `Array`
- **Required:** Yes
- **Default:** `undefined`



#### `callStartTime`

No description available.

- **Type:** `union`
- **Required:** No
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
  <VoiceChannelUserList
    :userIds="[]" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/voice/VoiceChannelUserList.vue`

---

*This documentation was automatically generated from the component source code.*