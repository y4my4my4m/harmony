# PublicServersFooter

A Vue component.

**File:** `src/components/PublicServers/PublicServersFooter.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[PublicServersFooter]
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
| `createServer` | unknown | No description |

### Event Details

#### `createServer`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <PublicServersFooter
    @createServer="handleCreateServer" />
</template>

<script setup lang="ts">
const handleCreateServer = (data) => {
  // Handle createServer event
}
</script>
```



## File Location

`src/components/PublicServers/PublicServersFooter.vue`

---

*This documentation was automatically generated from the component source code.*