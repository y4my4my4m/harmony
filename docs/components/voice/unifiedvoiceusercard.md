# UnifiedVoiceUserCard

A Vue component.

**File:** `src/components/voice/UnifiedVoiceUserCard.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[UnifiedVoiceUserCard]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `userState` | `UserMediaState` | `undefined` | ✅ | No description |

### Props Details

#### `userState`

No description available.

- **Type:** `UserMediaState`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `toggle-video` | unknown | No description |
| `toggle-screen-share` | unknown | No description |

### Event Details

#### `toggle-video`

No description available.

**Parameters:** `unknown`



#### `toggle-screen-share`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <UnifiedVoiceUserCard
    :userState="undefined"
    @toggle-video="handleToggle-video"
    @toggle-screen-share="handleToggle-screen-share" />
</template>

<script setup lang="ts">
const handleToggle-video = (data) => {
  // Handle toggle-video event
}

const handleToggle-screen-share = (data) => {
  // Handle toggle-screen-share event
}
</script>
```



## File Location

`src/components/voice/UnifiedVoiceUserCard.vue`

---

*This documentation was automatically generated from the component source code.*