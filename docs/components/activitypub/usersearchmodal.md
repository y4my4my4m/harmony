# UserSearchModal

A Vue component.

**File:** `src/components/activitypub/UserSearchModal.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[UserSearchModal]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

This component has no props.

## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `close` | `unknown` | No description |
| `user-selected` | `FederatedUser` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `user-selected`

No description available.

**Parameters:** `FederatedUser`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <UserSearchModal
    @close="handleClose"
    @user-selected="handleUserSelected" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleUserSelected = (data: FederatedUser) => {
  // Handle user-selected event
}
</script>
```



## File Location

`src/components/activitypub/UserSearchModal.vue`

---

*This documentation was automatically generated from the component source code.*