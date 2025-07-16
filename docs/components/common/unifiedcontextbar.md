# UnifiedContextBar

No description available.

**File:** `src/components/common/UnifiedContextBar.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[UnifiedContextBar]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `mode` | `union` | `undefined` | ✅ | No description |
| `isMobile` | `boolean` | `false` | ❌ | No description |
| `leftSidebarOpen` | `boolean` | `false` | ❌ | No description |
| `rightSidebarOpen` | `boolean` | `false` | ❌ | No description |
| `voicePanelOpen` | `boolean` | `false` | ❌ | No description |
| `currentServer` | `union` | `undefined` | ❌ | No description |
| `currentChannel` | `union` | `undefined` | ❌ | No description |
| `isDM` | `boolean` | `false` | ❌ | No description |
| `currentView` | `union` | `'home'` | ❌ | No description |
| `instanceDomain` | `string` | `undefined` | ❌ | No description |

### Props Details

#### `mode`

No description available.

- **Type:** `union`
- **Required:** Yes
- **Default:** `undefined`



#### `isMobile`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `leftSidebarOpen`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `rightSidebarOpen`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `voicePanelOpen`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `currentServer`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `undefined`



#### `currentChannel`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `undefined`



#### `isDM`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `currentView`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `'home'`



#### `instanceDomain`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `toggle-left-sidebar` | unknown | No description |
| `toggle-voice-panel` | unknown | No description |
| `toggle-search` | unknown | No description |
| `toggle-right-sidebar` | unknown | No description |
| `refresh-timeline` | unknown | No description |
| `open-search` | unknown | No description |
| `open-composer` | unknown | No description |
| `switch-feed` | union | No description |

### Event Details

#### `toggle-left-sidebar`

No description available.

**Parameters:** `unknown`



#### `toggle-voice-panel`

No description available.

**Parameters:** `unknown`



#### `toggle-search`

No description available.

**Parameters:** `unknown`



#### `toggle-right-sidebar`

No description available.

**Parameters:** `unknown`



#### `refresh-timeline`

No description available.

**Parameters:** `unknown`



#### `open-search`

No description available.

**Parameters:** `unknown`



#### `open-composer`

No description available.

**Parameters:** `unknown`



#### `switch-feed`

No description available.

**Parameters:** `union`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <UnifiedContextBar
    :mode="undefined"
    @toggle-left-sidebar="handleToggle-left-sidebar"
    @toggle-voice-panel="handleToggle-voice-panel"
    @toggle-search="handleToggle-search"
    @toggle-right-sidebar="handleToggle-right-sidebar"
    @refresh-timeline="handleRefresh-timeline"
    @open-search="handleOpen-search"
    @open-composer="handleOpen-composer"
    @switch-feed="handleSwitch-feed" />
</template>

<script setup lang="ts">
const handleToggle-left-sidebar = (data) => {
  // Handle toggle-left-sidebar event
}

const handleToggle-voice-panel = (data) => {
  // Handle toggle-voice-panel event
}

const handleToggle-search = (data) => {
  // Handle toggle-search event
}

const handleToggle-right-sidebar = (data) => {
  // Handle toggle-right-sidebar event
}

const handleRefresh-timeline = (data) => {
  // Handle refresh-timeline event
}

const handleOpen-search = (data) => {
  // Handle open-search event
}

const handleOpen-composer = (data) => {
  // Handle open-composer event
}

const handleSwitch-feed = (union) => {
  // Handle switch-feed event
}
</script>
```



## File Location

`src/components/common/UnifiedContextBar.vue`

---

*This documentation was automatically generated from the component source code.*