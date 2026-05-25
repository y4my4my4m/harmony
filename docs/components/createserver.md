# CreateServer

A Vue component.

**File:** `src/components/CreateServer.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[CreateServer]
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

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <CreateServer
    @close="handleClose" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}
</script>
```



## File Location

`src/components/CreateServer.vue`

---

*This documentation was automatically generated from the component source code.*