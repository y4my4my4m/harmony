# UserPreviewComponent

A Vue component.

**File:** `src/components/UserPreviewComponent.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[UserPreviewComponent]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `user` | `User` | `undefined` | ✅ | No description |
| `closeProfile` | `func` | `undefined` | ❌ | No description |

### Props Details

#### `user`

No description available.

- **Type:** `User`
- **Required:** Yes
- **Default:** `undefined`



#### `closeProfile`

No description available.

- **Type:** `func`
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
  <UserPreviewComponent
    :user="undefined" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/UserPreviewComponent.vue`

---

*This documentation was automatically generated from the component source code.*