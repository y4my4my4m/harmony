# JoinFederatedServer

A Vue component.

**File:** `src/components/JoinFederatedServer.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[JoinFederatedServer]
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
| `close` | `unknown` | No description |
| `joined` | `string` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `joined`

No description available.

**Parameters:** `string`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <JoinFederatedServer
    @close="handleClose"
    @joined="handleJoined" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleJoined = (data: string) => {
  // Handle joined event
}
</script>
```



## File Location

`src/components/JoinFederatedServer.vue`

---

*This documentation was automatically generated from the component source code.*