# AdvancedSettings

A Vue component.

**File:** `src/components/settings/user/AdvancedSettings.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[AdvancedSettings]
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
| `update-advanced` | `any` | No description |

### Event Details

#### `update-advanced`

No description available.

**Parameters:** `any`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <AdvancedSettings
    :loading="true"
    @update-advanced="handleUpdateAdvanced" />
</template>

<script setup lang="ts">
const handleUpdateAdvanced = (data: any) => {
  // Handle update-advanced event
}
</script>
```



## File Location

`src/components/settings/user/AdvancedSettings.vue`

---

*This documentation was automatically generated from the component source code.*