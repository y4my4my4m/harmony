# VoiceSettingsInline

A Vue component.

**File:** `src/components/settings/user/VoiceSettingsInline.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[VoiceSettingsInline]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `loading` | `boolean` | `undefined` | ❌ | No description |

### Props Details

#### `loading`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `update-voice-settings` | `any` | No description |

### Event Details

#### `update-voice-settings`

No description available.

**Parameters:** `any`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <VoiceSettingsInline
    
    @update-voice-settings="handleUpdateVoiceSettings" />
</template>

<script setup lang="ts">
const handleUpdateVoiceSettings = (data: any) => {
  // Handle update-voice-settings event
}
</script>
```



## File Location

`src/components/settings/user/VoiceSettingsInline.vue`

---

*This documentation was automatically generated from the component source code.*