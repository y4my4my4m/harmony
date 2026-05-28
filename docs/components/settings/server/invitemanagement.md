# InviteManagement

A Vue component.

**File:** `src/components/settings/server/InviteManagement.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[InviteManagement]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `serverId` | `string` | `undefined` | ✅ | No description |

### Props Details

#### `serverId`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `create-invite` | `unknown` | No description |

### Event Details

#### `create-invite`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <InviteManagement
    :serverId=""example""
    @create-invite="handleCreateInvite" />
</template>

<script setup lang="ts">
const handleCreateInvite = (data: unknown) => {
  // Handle create-invite event
}
</script>
```



## File Location

`src/components/settings/server/InviteManagement.vue`

---

*This documentation was automatically generated from the component source code.*