# UnifiedContentArea

A Vue component.

**File:** `src/components/common/UnifiedContentArea.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[UnifiedContentArea]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `mode` | `ViewMode` | `undefined` | ✅ | No description |
| `chatMessages` | `Array` | `() => []` | ❌ | No description |
| `isLoading` | `boolean` | `false` | ❌ | No description |
| `isDM` | `boolean` | `false` | ❌ | No description |
| `channelId` | `string` | `undefined` | ❌ | No description |
| `conversationId` | `string` | `undefined` | ❌ | No description |
| `channelName` | `string` | `undefined` | ❌ | No description |
| `dmUsername` | `string` | `undefined` | ❌ | No description |
| `viewType` | `ViewType` | `ViewType.TIMELINE` | ❌ | No description |
| `currentView` | `string` | `'home'` | ❌ | No description |
| `posts` | `Array` | `() => []` | ❌ | No description |
| `isLoadingFeed` | `boolean` | `false` | ❌ | No description |
| `hasMorePosts` | `boolean` | `false` | ❌ | No description |
| `profileUser` | `union` | `null` | ❌ | No description |
| `profileHandle` | `string` | `undefined` | ❌ | No description |
| `specialViewData` | `Array` | `() => []` | ❌ | No description |
| `hasMoreSpecialData` | `boolean` | `false` | ❌ | No description |
| `postId` | `string` | `undefined` | ❌ | No description |

### Props Details

#### `mode`

No description available.

- **Type:** `ViewMode`
- **Required:** Yes
- **Default:** `undefined`



#### `chatMessages`

No description available.

- **Type:** `Array`
- **Required:** No
- **Default:** `() => []`



#### `isLoading`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `isDM`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `channelId`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `conversationId`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `channelName`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `dmUsername`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `viewType`

No description available.

- **Type:** `ViewType`
- **Required:** No
- **Default:** `ViewType.TIMELINE`



#### `currentView`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `'home'`



#### `posts`

No description available.

- **Type:** `Array`
- **Required:** No
- **Default:** `() => []`



#### `isLoadingFeed`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `hasMorePosts`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `profileUser`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `null`



#### `profileHandle`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `specialViewData`

No description available.

- **Type:** `Array`
- **Required:** No
- **Default:** `() => []`



#### `hasMoreSpecialData`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `postId`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `update:is-at-bottom` | boolean | No description |
| `send-message` | any | No description |
| `show-all-threads` | unknown | No description |
| `clear-all-bookmarks` | unknown | No description |
| `load-more-special-data` | unknown | No description |
| `switch-feed` | union | No description |
| `post-created` | TimelinePost | No description |
| `load-more-posts` | unknown | No description |
| `reply-to-post` | any | No description |
| `favorite-post` | string | No description |
| `reblog-post` | string | No description |
| `bookmark-post` | string | No description |
| `delete-post` | string | No description |
| `show-user-profile` | any | No description |
| `load-more-messages` | unknown | No description |
| `back-to-timeline` | unknown | No description |

### Event Details

#### `update:is-at-bottom`

No description available.

**Parameters:** `boolean`



#### `send-message`

No description available.

**Parameters:** `any`



#### `show-all-threads`

No description available.

**Parameters:** `unknown`



#### `clear-all-bookmarks`

No description available.

**Parameters:** `unknown`



#### `load-more-special-data`

No description available.

**Parameters:** `unknown`



#### `switch-feed`

No description available.

**Parameters:** `union`



#### `post-created`

No description available.

**Parameters:** `TimelinePost`



#### `load-more-posts`

No description available.

**Parameters:** `unknown`



#### `reply-to-post`

No description available.

**Parameters:** `any`



#### `favorite-post`

No description available.

**Parameters:** `string`



#### `reblog-post`

No description available.

**Parameters:** `string`



#### `bookmark-post`

No description available.

**Parameters:** `string`



#### `delete-post`

No description available.

**Parameters:** `string`



#### `show-user-profile`

No description available.

**Parameters:** `any`



#### `load-more-messages`

No description available.

**Parameters:** `unknown`



#### `back-to-timeline`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <UnifiedContentArea
    :mode="undefined"
    @update:is-at-bottom="handleUpdate:is-at-bottom"
    @send-message="handleSend-message"
    @show-all-threads="handleShow-all-threads"
    @clear-all-bookmarks="handleClear-all-bookmarks"
    @load-more-special-data="handleLoad-more-special-data"
    @switch-feed="handleSwitch-feed"
    @post-created="handlePost-created"
    @load-more-posts="handleLoad-more-posts"
    @reply-to-post="handleReply-to-post"
    @favorite-post="handleFavorite-post"
    @reblog-post="handleReblog-post"
    @bookmark-post="handleBookmark-post"
    @delete-post="handleDelete-post"
    @show-user-profile="handleShow-user-profile"
    @load-more-messages="handleLoad-more-messages"
    @back-to-timeline="handleBack-to-timeline" />
</template>

<script setup lang="ts">
const handleUpdate:is-at-bottom = (boolean) => {
  // Handle update:is-at-bottom event
}

const handleSend-message = (any) => {
  // Handle send-message event
}

const handleShow-all-threads = (data) => {
  // Handle show-all-threads event
}

const handleClear-all-bookmarks = (data) => {
  // Handle clear-all-bookmarks event
}

const handleLoad-more-special-data = (data) => {
  // Handle load-more-special-data event
}

const handleSwitch-feed = (union) => {
  // Handle switch-feed event
}

const handlePost-created = (TimelinePost) => {
  // Handle post-created event
}

const handleLoad-more-posts = (data) => {
  // Handle load-more-posts event
}

const handleReply-to-post = (any) => {
  // Handle reply-to-post event
}

const handleFavorite-post = (string) => {
  // Handle favorite-post event
}

const handleReblog-post = (string) => {
  // Handle reblog-post event
}

const handleBookmark-post = (string) => {
  // Handle bookmark-post event
}

const handleDelete-post = (string) => {
  // Handle delete-post event
}

const handleShow-user-profile = (any) => {
  // Handle show-user-profile event
}

const handleLoad-more-messages = (data) => {
  // Handle load-more-messages event
}

const handleBack-to-timeline = (data) => {
  // Handle back-to-timeline event
}
</script>
```



## File Location

`src/components/common/UnifiedContentArea.vue`

---

*This documentation was automatically generated from the component source code.*