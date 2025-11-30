# PostDetailDisplay

A Vue component.

**File:** `src/components/common/PostDetailDisplay.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[PostDetailDisplay]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `postId` | `string` | `undefined` | ✅ | No description |

### Props Details

#### `postId`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `back` | unknown | No description |
| `reply` | TimelinePost | No description |
| `favorite` | string | No description |
| `reblog` | string | No description |
| `bookmark` | string | No description |
| `delete` | string | No description |
| `user-click` | any | No description |

### Event Details

#### `back`

No description available.

**Parameters:** `unknown`



#### `reply`

No description available.

**Parameters:** `TimelinePost`



#### `favorite`

No description available.

**Parameters:** `string`



#### `reblog`

No description available.

**Parameters:** `string`



#### `bookmark`

No description available.

**Parameters:** `string`



#### `delete`

No description available.

**Parameters:** `string`



#### `user-click`

No description available.

**Parameters:** `any`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <PostDetailDisplay
    :postId=""example""
    @back="handleBack"
    @reply="handleReply"
    @favorite="handleFavorite"
    @reblog="handleReblog"
    @bookmark="handleBookmark"
    @delete="handleDelete"
    @user-click="handleUser-click" />
</template>

<script setup lang="ts">
const handleBack = (data) => {
  // Handle back event
}

const handleReply = (TimelinePost) => {
  // Handle reply event
}

const handleFavorite = (string) => {
  // Handle favorite event
}

const handleReblog = (string) => {
  // Handle reblog event
}

const handleBookmark = (string) => {
  // Handle bookmark event
}

const handleDelete = (string) => {
  // Handle delete event
}

const handleUser-click = (any) => {
  // Handle user-click event
}
</script>
```



## File Location

`src/components/common/PostDetailDisplay.vue`

---

*This documentation was automatically generated from the component source code.*