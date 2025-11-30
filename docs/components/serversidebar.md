# ServerSidebar

A Vue component.

**File:** `src/components/ServerSidebar.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ServerSidebar]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `servers` | `Array` | `undefined` | ✅ | No description |

### Props Details

#### `servers`

No description available.

- **Type:** `Array`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `show-public-servers` | boolean | No description |
| `switch-to-activitypub` | unknown | No description |
| `switch-to-chat` | unknown | No description |

### Event Details

#### `show-public-servers`

No description available.

**Parameters:** `boolean`



#### `switch-to-activitypub`

No description available.

**Parameters:** `unknown`



#### `switch-to-chat`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ServerSidebar
    :servers="[]"
    @show-public-servers="handleShow-public-servers"
    @switch-to-activitypub="handleSwitch-to-activitypub"
    @switch-to-chat="handleSwitch-to-chat" />
</template>

<script setup lang="ts">
const handleShow-public-servers = (boolean) => {
  // Handle show-public-servers event
}

const handleSwitch-to-activitypub = (data) => {
  // Handle switch-to-activitypub event
}

const handleSwitch-to-chat = (data) => {
  // Handle switch-to-chat event
}
</script>
```



## File Location

`src/components/ServerSidebar.vue`

---

*This documentation was automatically generated from the component source code.*