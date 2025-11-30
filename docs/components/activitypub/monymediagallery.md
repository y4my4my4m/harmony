# MonyMediaGallery

A Vue component.

**File:** `src/components/activitypub/MonyMediaGallery.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[MonyMediaGallery]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `mediaAttachments` | `Array` | `undefined` | ✅ | No description |
| `isSensitive` | `boolean` | `false` | ❌ | No description |

### Props Details

#### `mediaAttachments`

No description available.

- **Type:** `Array`
- **Required:** Yes
- **Default:** `undefined`



#### `isSensitive`

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
  <MonyMediaGallery
    :mediaAttachments="[]" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/activitypub/MonyMediaGallery.vue`

---

*This documentation was automatically generated from the component source code.*