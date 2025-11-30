# EncryptionIndicator

A Vue component.

**File:** `src/components/encryption/EncryptionIndicator.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[EncryptionIndicator]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `encrypted` | `boolean` | `false` | ❌ | No description |
| `mode` | `union` | `'message'` | ❌ | No description |
| `showLabel` | `boolean` | `false` | ❌ | No description |
| `size` | `union` | `'medium'` | ❌ | No description |

### Props Details

#### `encrypted`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `mode`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `'message'`



#### `showLabel`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `size`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `'medium'`




## Events

This component emits no events.

## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <EncryptionIndicator
     />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/encryption/EncryptionIndicator.vue`

---

*This documentation was automatically generated from the component source code.*