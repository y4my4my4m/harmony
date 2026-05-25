# AudioThemePicker

A Vue component.

**File:** `src/components/settings/AudioThemePicker.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[AudioThemePicker]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `showTestButton` | `boolean` | `true` | ❌ | No description |
| `showVolumeControl` | `boolean` | `true` | ❌ | No description |
| `compact` | `boolean` | `false` | ❌ | No description |

### Props Details

#### `showTestButton`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`



#### `showVolumeControl`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`



#### `compact`

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
  <AudioThemePicker
     />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/settings/AudioThemePicker.vue`

---

*This documentation was automatically generated from the component source code.*