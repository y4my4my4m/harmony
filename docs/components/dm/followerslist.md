# FollowersList

A Vue component.

**File:** `src/components/dm/FollowersList.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[FollowersList]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

This component has no props.

## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `conversationStarted` | `string` | No description |

### Event Details

#### `conversationStarted`

No description available.

**Parameters:** `string`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <FollowersList
    @conversationStarted="handleConversationStarted" />
</template>

<script setup lang="ts">
const handleConversationStarted = (data: string) => {
  // Handle conversationStarted event
}
</script>
```



## File Location

`src/components/dm/FollowersList.vue`

---

*This documentation was automatically generated from the component source code.*