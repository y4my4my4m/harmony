# FileUploadMenu

A Vue component.

**File:** `src/components/FileUploadMenu.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[FileUploadMenu]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `isVisible` | `boolean` | `false` | ❌ | No description |

### Props Details

#### `isVisible`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `files-selected` | `unknown` | No description |
| `close` | `unknown` | No description |

### Event Details

#### `files-selected`

No description available.

**Parameters:** `unknown`



#### `close`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <FileUploadMenu
    
    @files-selected="handleFilesSelected"
    @close="handleClose" />
</template>

<script setup lang="ts">
const handleFilesSelected = (data: unknown) => {
  // Handle files-selected event
}

const handleClose = (data: unknown) => {
  // Handle close event
}
</script>
```



## File Location

`src/components/FileUploadMenu.vue`

---

*This documentation was automatically generated from the component source code.*