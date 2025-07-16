# MonyPost

No description available.

**File:** `src/components/activitypub/MonyPost.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[MonyPost]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `post` | `TimelinePost` | `undefined` | ✅ | No description |

### Props Details

#### `post`

No description available.

- **Type:** `TimelinePost`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `reply` | TimelinePost | No description |
| `delete` | string | No description |
| `edit` | string | No description |
| `click` | TimelinePost | No description |
| `user-mention-click` | string | No description |
| `hashtag-click` | string | No description |
| `user-click` | any | No description |
| `show-conversation` | string | No description |

### Event Details

#### `reply`

No description available.

**Parameters:** `TimelinePost`



#### `delete`

No description available.

**Parameters:** `string`



#### `edit`

No description available.

**Parameters:** `string`



#### `click`

No description available.

**Parameters:** `TimelinePost`



#### `user-mention-click`

No description available.

**Parameters:** `string`



#### `hashtag-click`

No description available.

**Parameters:** `string`



#### `user-click`

No description available.

**Parameters:** `any`



#### `show-conversation`

No description available.

**Parameters:** `string`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <MonyPost
    :post="undefined"
    @reply="handleReply"
    @delete="handleDelete"
    @edit="handleEdit"
    @click="handleClick"
    @user-mention-click="handleUser-mention-click"
    @hashtag-click="handleHashtag-click"
    @user-click="handleUser-click"
    @show-conversation="handleShow-conversation" />
</template>

<script setup lang="ts">
const handleReply = (TimelinePost) => {
  // Handle reply event
}

const handleDelete = (string) => {
  // Handle delete event
}

const handleEdit = (string) => {
  // Handle edit event
}

const handleClick = (TimelinePost) => {
  // Handle click event
}

const handleUser-mention-click = (string) => {
  // Handle user-mention-click event
}

const handleHashtag-click = (string) => {
  // Handle hashtag-click event
}

const handleUser-click = (any) => {
  // Handle user-click event
}

const handleShow-conversation = (string) => {
  // Handle show-conversation event
}
</script>
```



## File Location

`src/components/activitypub/MonyPost.vue`

---

*This documentation was automatically generated from the component source code.*