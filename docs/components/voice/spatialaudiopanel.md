# SpatialAudioPanel

A Vue component.

**File:** `src/components/voice/SpatialAudioPanel.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[SpatialAudioPanel]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isUnderOverlay` | `boolean` | `false` | ❌ | No description |
| `isUnderDock` | `boolean` | `false` | ❌ | No description |

### Props Details

#### `isUnderOverlay`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `isUnderDock`

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
  <SpatialAudioPanel
     />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/voice/SpatialAudioPanel.vue`

---

*This documentation was automatically generated from the component source code.*