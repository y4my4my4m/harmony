# PrivacySettings

A Vue component.

**File:** `src/components/settings/user/PrivacySettings.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[PrivacySettings]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `profile` | `union` | `undefined` | ✅ | No description |
| `loading` | `boolean` | `undefined` | ✅ | No description |

### Props Details

#### `profile`

No description available.

- **Type:** `union`
- **Required:** Yes
- **Default:** `undefined`



#### `loading`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `update-privacy` | `any` | No description |

### Event Details

#### `update-privacy`

No description available.

**Parameters:** `any`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <PrivacySettings
    :profile="undefined"
    :loading="true"
    @update-privacy="handleUpdatePrivacy" />
</template>

<script setup lang="ts">
const handleUpdatePrivacy = (data: any) => {
  // Handle update-privacy event
}
</script>
```



## File Location

`src/components/settings/user/PrivacySettings.vue`

---

*This documentation was automatically generated from the component source code.*