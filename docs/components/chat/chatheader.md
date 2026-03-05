# ChatHeader

A Vue component.

**File:** `src/components/chat/ChatHeader.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ChatHeader]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `channel` | `Channel` | `undefined` | ✅ | No description |
| `server` | `Server` | `undefined` | ❌ | No description |
| `isMobile` | `boolean` | `undefined` | ❌ | No description |
| `rightSidebarOpen` | `boolean` | `undefined` | ❌ | No description |

### Props Details

#### `channel`

No description available.

- **Type:** `Channel`
- **Required:** Yes
- **Default:** `undefined`



#### `server`

No description available.

- **Type:** `Server`
- **Required:** No
- **Default:** `undefined`



#### `isMobile`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`



#### `rightSidebarOpen`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `toggle-left-sidebar` | `unknown` | No description |
| `toggle-right-sidebar` | `unknown` | No description |
| `toggle-search` | `unknown` | No description |
| `show-pinned` | `unknown` | No description |
| `show-threads` | `unknown` | No description |

### Event Details

#### `toggle-left-sidebar`

No description available.

**Parameters:** `unknown`



#### `toggle-right-sidebar`

No description available.

**Parameters:** `unknown`



#### `toggle-search`

No description available.

**Parameters:** `unknown`



#### `show-pinned`

No description available.

**Parameters:** `unknown`



#### `show-threads`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ChatHeader
    :channel="undefined"
    @toggle-left-sidebar="handleToggleLeftSidebar"
    @toggle-right-sidebar="handleToggleRightSidebar"
    @toggle-search="handleToggleSearch"
    @show-pinned="handleShowPinned"
    @show-threads="handleShowThreads" />
</template>

<script setup lang="ts">
const handleToggleLeftSidebar = (data: unknown) => {
  // Handle toggle-left-sidebar event
}

const handleToggleRightSidebar = (data: unknown) => {
  // Handle toggle-right-sidebar event
}

const handleToggleSearch = (data: unknown) => {
  // Handle toggle-search event
}

const handleShowPinned = (data: unknown) => {
  // Handle show-pinned event
}

const handleShowThreads = (data: unknown) => {
  // Handle show-threads event
}
</script>
```



## File Location

`src/components/chat/ChatHeader.vue`

---

*This documentation was automatically generated from the component source code.*