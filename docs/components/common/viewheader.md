# ViewHeader

A Vue component.

**File:** `src/components/common/ViewHeader.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ViewHeader]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `viewType` | `string` | `undefined` | ✅ | No description |
| `dataCount` | `number` | `undefined` | ❌ | No description |

### Props Details

#### `viewType`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `dataCount`

No description available.

- **Type:** `number`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `clear-all` | `unknown` | No description |

### Event Details

#### `clear-all`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ViewHeader
    :viewType=""example""
    @clear-all="handleClearAll" />
</template>

<script setup lang="ts">
const handleClearAll = (data: unknown) => {
  // Handle clear-all event
}
</script>
```



## File Location

`src/components/common/ViewHeader.vue`

---

*This documentation was automatically generated from the component source code.*