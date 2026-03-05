# KeybindSettings

A Vue component.

**File:** `src/components/settings/user/KeybindSettings.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[KeybindSettings]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `loading` | `boolean` | `undefined` | ✅ | No description |

### Props Details

#### `loading`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `update-keybinds` | `any` | No description |

### Event Details

#### `update-keybinds`

No description available.

**Parameters:** `any`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <KeybindSettings
    :loading="true"
    @update-keybinds="handleUpdateKeybinds" />
</template>

<script setup lang="ts">
const handleUpdateKeybinds = (data: any) => {
  // Handle update-keybinds event
}
</script>
```



## File Location

`src/components/settings/user/KeybindSettings.vue`

---

*This documentation was automatically generated from the component source code.*