# IconComponent

A Vue component.

**File:** `src/components/common/Icon.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[Icon]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `name` | `string` | `undefined` | ✅ | No description |
| `size` | `string|number` | `'md'` | ❌ | No description |

### Props Details

#### `name`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `size`

No description available.

- **Type:** `string|number`
- **Required:** No
- **Default:** `'md'`




## Events

This component emits no events.

## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <Icon
    :name=""example"" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/common/Icon.vue`

---

*This documentation was automatically generated from the component source code.*