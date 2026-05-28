# PWAInstallPrompt

A Vue component.

**File:** `src/components/PWAInstallPrompt.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[PWAInstallPrompt]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `variant` | `union` | `'banner'` | ❌ | No description |
| `isInSettings` | `boolean` | `false` | ❌ | No description |

### Props Details

#### `variant`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `'banner'`



#### `isInSettings`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`




## Events

This component emits no events.

## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <PWAInstallPrompt
     />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/PWAInstallPrompt.vue`

---

*This documentation was automatically generated from the component source code.*