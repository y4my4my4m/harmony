# InviteModal

A Vue component.

**File:** `src/components/InviteModal.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[InviteModal]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `show` | `boolean` | `undefined` | ✅ | No description |
| `serverId` | `string` | `undefined` | ❌ | No description |
| `serverData` | `{
  id: string
  name: string
  icon_url?: string
  member_count?: number
}` | `undefined` | ❌ | No description |

### Props Details

#### `show`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `serverId`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `serverData`

No description available.

- **Type:** `{
  id: string
  name: string
  icon_url?: string
  member_count?: number
}`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |

### Event Details

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
  <InviteModal
    :show="true"
    @close="handleClose" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}
</script>
```



## File Location

`src/components/InviteModal.vue`

---

*This documentation was automatically generated from the component source code.*