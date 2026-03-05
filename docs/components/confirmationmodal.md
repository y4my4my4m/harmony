# ConfirmationModal

A Vue component.

**File:** `src/components/ConfirmationModal.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ConfirmationModal]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `show` | `boolean` | `undefined` | ✅ | No description |
| `title` | `string` | `undefined` | ✅ | No description |
| `message` | `string` | `undefined` | ✅ | No description |
| `secondaryMessage` | `string` | `undefined` | ❌ | No description |
| `confirmButtonText` | `string` | `'Delete'` | ❌ | No description |
| `requireConfirmation` | `boolean` | `false` | ❌ | No description |
| `confirmationText` | `string` | `'DELETE'` | ❌ | No description |

### Props Details

#### `show`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `title`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `message`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `secondaryMessage`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `confirmButtonText`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `'Delete'`



#### `requireConfirmation`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `confirmationText`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `'DELETE'`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `update:modelValue` | `boolean` | No description |
| `confirm` | `unknown` | No description |
| `close` | `unknown` | No description |

### Event Details

#### `update:modelValue`

No description available.

**Parameters:** `boolean`



#### `confirm`

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
  <ConfirmationModal
    :show="true"
    :title=""example""
    :message=""example""
    @update:modelValue="handleUpdate:modelValue"
    @confirm="handleConfirm"
    @close="handleClose" />
</template>

<script setup lang="ts">
const handleUpdate:modelValue = (data: boolean) => {
  // Handle update:modelValue event
}

const handleConfirm = (data: unknown) => {
  // Handle confirm event
}

const handleClose = (data: unknown) => {
  // Handle close event
}
</script>
```



## File Location

`src/components/ConfirmationModal.vue`

---

*This documentation was automatically generated from the component source code.*