# HeadphonesIcon

A Vue component.

**File:** `src/components/icons/Headphones.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[Headphones]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isHeadphonesActive` | `boolean` | `undefined` | ✅ | No description |

### Props Details

#### `isHeadphonesActive`

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
  <Headphones
    :isHeadphonesActive="true" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/icons/Headphones.vue`

---

*This documentation was automatically generated from the component source code.*