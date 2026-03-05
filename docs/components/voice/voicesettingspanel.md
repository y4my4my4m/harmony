# VoiceSettingsPanel

A Vue component.

**File:** `src/components/voice/VoiceSettingsPanel.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[VoiceSettingsPanel]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

This component has no props.

## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |
| `update-settings` | `unknown` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `update-settings`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <VoiceSettingsPanel
    @close="handleClose"
    @update-settings="handleUpdateSettings" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleUpdateSettings = (data: unknown) => {
  // Handle update-settings event
}
</script>
```



## File Location

`src/components/voice/VoiceSettingsPanel.vue`

---

*This documentation was automatically generated from the component source code.*