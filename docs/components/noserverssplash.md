# NoServersSplash

A Vue component.

**File:** `src/components/NoServersSplash.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[NoServersSplash]
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
| `showPublicServers` | `unknown` | No description |

### Event Details

#### `showPublicServers`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <NoServersSplash
    @showPublicServers="handleShowPublicServers" />
</template>

<script setup lang="ts">
const handleShowPublicServers = (data: unknown) => {
  // Handle showPublicServers event
}
</script>
```



## File Location

`src/components/NoServersSplash.vue`

---

*This documentation was automatically generated from the component source code.*