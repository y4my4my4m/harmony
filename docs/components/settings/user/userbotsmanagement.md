# UserBotsManagement

A Vue component.

**File:** `src/components/settings/user/UserBotsManagement.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[UserBotsManagement]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `loading` | `boolean` | `undefined` | ✅ | No description |

### Props Details

#### `loading`

No description available.

- **Type:** `boolean`
- **Required:** Yes
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
  <UserBotsManagement
    :loading="true" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/settings/user/UserBotsManagement.vue`

---

*This documentation was automatically generated from the component source code.*