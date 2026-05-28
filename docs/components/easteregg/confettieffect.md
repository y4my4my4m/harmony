# ConfettiEffect

A Vue component.

**File:** `src/components/easteregg/ConfettiEffect.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ConfettiEffect]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isActive` | `boolean` | `undefined` | ✅ | No description |
| `duration` | `number` | `10000` | ❌ | No description |

### Props Details

#### `isActive`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `duration`

No description available.

- **Type:** `number`
- **Required:** No
- **Default:** `10000`




## Events

This component emits no events.

## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ConfettiEffect
    :isActive="true" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/easteregg/ConfettiEffect.vue`

---

*This documentation was automatically generated from the component source code.*