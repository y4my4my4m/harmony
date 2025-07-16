# UnifiedContentArea

No description available.

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
| `load-more-messages` | unknown | No description |
| `update:is-at-bottom` | boolean | No description |
| `send-message` | any | No description |
| `clear-all-bookmarks` | unknown | No description |
| `load-more-special-data` | unknown | No description |
| `switch-feed` | union | No description |
| `post-created` | TimelinePost | No description |
| `load-more-posts` | unknown | No description |
| `back-to-timeline` | unknown | No description |

### Event Details

#### `load-more-messages`

No description available.

**Parameters:** `unknown`



#### `update:is-at-bottom`

No description available.

**Parameters:** `boolean`



#### `send-message`

No description available.

**Parameters:** `any`



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
    @load-more-messages="handleLoad-more-messages"
    @update:is-at-bottom="handleUpdate:is-at-bottom"
    @send-message="handleSend-message"
    @clear-all-bookmarks="handleClear-all-bookmarks"
    @load-more-special-data="handleLoad-more-special-data"
    @switch-feed="handleSwitch-feed"
    @post-created="handlePost-created"
    @load-more-posts="handleLoad-more-posts"
    @back-to-timeline="handleBack-to-timeline" />
</template>

<script setup lang="ts">
const handleLoad-more-messages = (data) => {
  // Handle load-more-messages event
}

const handleUpdate:is-at-bottom = (boolean) => {
  // Handle update:is-at-bottom event
}

const handleSend-message = (any) => {
  // Handle send-message event
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

const handleBack-to-timeline = (data) => {
  // Handle back-to-timeline event
}
</script>
```



## File Location

`src/components/common/UnifiedContentArea.vue`

---

*This documentation was automatically generated from the component source code.*