# ServerFolderSettingsModal

A Vue component.

**File:** `src/components/ServerFolderSettingsModal.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ServerFolderSettingsModal]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isOpen` | `boolean` | `undefined` | ✅ | No description |
| `folder` | `union` | `undefined` | ❌ | No description |

### Props Details

#### `isOpen`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `folder`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |
| `saved` | `ServerFolder` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `saved`

No description available.

**Parameters:** `ServerFolder`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ServerFolderSettingsModal
    :isOpen="true"
    @close="handleClose"
    @saved="handleSaved" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleSaved = (data: ServerFolder) => {
  // Handle saved event
}
</script>
```



## File Location

`src/components/ServerFolderSettingsModal.vue`

---

*This documentation was automatically generated from the component source code.*