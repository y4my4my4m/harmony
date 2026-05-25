# UserCard

A Vue component.

**File:** `src/components/activitypub/UserCard.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[UserCard]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `user` | `FederatedUser` | `undefined` | ✅ | No description |
| `isCompact` | `boolean` | `false` | ❌ | No description |
| `showFollowBtn` | `boolean` | `true` | ❌ | No description |
| `showMoreActions` | `boolean` | `true` | ❌ | No description |
| `showInstanceBadge` | `boolean` | `true` | ❌ | No description |
| `showActions` | `boolean` | `true` | ❌ | No description |

### Props Details

#### `user`

No description available.

- **Type:** `FederatedUser`
- **Required:** Yes
- **Default:** `undefined`



#### `isCompact`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `showFollowBtn`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`



#### `showMoreActions`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`



#### `showInstanceBadge`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`



#### `showActions`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `follow` | `string` | No description |
| `unfollow` | `string` | No description |
| `mention` | `FederatedUser` | No description |
| `block` | `string` | No description |
| `unblock` | `string` | No description |
| `mute` | `string` | No description |
| `unmute` | `string` | No description |
| `report` | `string` | No description |
| `user-click` | `FederatedUser` | No description |

### Event Details

#### `follow`

No description available.

**Parameters:** `string`



#### `unfollow`

No description available.

**Parameters:** `string`



#### `mention`

No description available.

**Parameters:** `FederatedUser`



#### `block`

No description available.

**Parameters:** `string`



#### `unblock`

No description available.

**Parameters:** `string`



#### `mute`

No description available.

**Parameters:** `string`



#### `unmute`

No description available.

**Parameters:** `string`



#### `report`

No description available.

**Parameters:** `string`



#### `user-click`

No description available.

**Parameters:** `FederatedUser`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <UserCard
    :user="undefined"
    @follow="handleFollow"
    @unfollow="handleUnfollow"
    @mention="handleMention"
    @block="handleBlock"
    @unblock="handleUnblock"
    @mute="handleMute"
    @unmute="handleUnmute"
    @report="handleReport"
    @user-click="handleUserClick" />
</template>

<script setup lang="ts">
const handleFollow = (data: string) => {
  // Handle follow event
}

const handleUnfollow = (data: string) => {
  // Handle unfollow event
}

const handleMention = (data: FederatedUser) => {
  // Handle mention event
}

const handleBlock = (data: string) => {
  // Handle block event
}

const handleUnblock = (data: string) => {
  // Handle unblock event
}

const handleMute = (data: string) => {
  // Handle mute event
}

const handleUnmute = (data: string) => {
  // Handle unmute event
}

const handleReport = (data: string) => {
  // Handle report event
}

const handleUserClick = (data: FederatedUser) => {
  // Handle user-click event
}
</script>
```



## File Location

`src/components/activitypub/UserCard.vue`

---

*This documentation was automatically generated from the component source code.*