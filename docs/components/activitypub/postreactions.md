# PostReactions

A Vue component.

**File:** `src/components/activitypub/PostReactions.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[PostReactions]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `post` | `TimelinePost` | `undefined` | ✅ | No description |
| `showReactions` | `boolean` | `true` | ❌ | No description |

### Props Details

#### `post`

No description available.

- **Type:** `TimelinePost`
- **Required:** Yes
- **Default:** `undefined`



#### `showReactions`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `show-reaction-tooltip` | MouseEvent | No description |
| `hide-reaction-tooltip` | unknown | No description |

### Event Details

#### `show-reaction-tooltip`

No description available.

**Parameters:** `MouseEvent`



#### `hide-reaction-tooltip`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <PostReactions
    :post="undefined"
    @show-reaction-tooltip="handleShow-reaction-tooltip"
    @hide-reaction-tooltip="handleHide-reaction-tooltip" />
</template>

<script setup lang="ts">
const handleShow-reaction-tooltip = (MouseEvent) => {
  // Handle show-reaction-tooltip event
}

const handleHide-reaction-tooltip = (data) => {
  // Handle hide-reaction-tooltip event
}
</script>
```



## File Location

`src/components/activitypub/PostReactions.vue`

---

*This documentation was automatically generated from the component source code.*