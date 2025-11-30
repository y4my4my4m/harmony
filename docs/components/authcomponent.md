# AuthComponent

A Vue component.

**File:** `src/components/AuthComponent.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[AuthComponent]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isLogin` | `boolean` | `true` | ❌ | No description |

### Props Details

#### `isLogin`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`




## Events

This component emits no events.

## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <AuthComponent
     />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/AuthComponent.vue`

---

*This documentation was automatically generated from the component source code.*