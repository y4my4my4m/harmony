# PublicServers

A Vue component.

**File:** `src/components/PublicServers.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[PublicServers]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `forceRefresh` | `boolean` | `false` | ❌ | Force refresh data when modal opens |

### Props Details

#### `forceRefresh`

Force refresh data when modal opens

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`




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
  <PublicServers
    
    @close="handleClose" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}
</script>
```



## File Location

`src/components/PublicServers.vue`

---

*This documentation was automatically generated from the component source code.*