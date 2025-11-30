# DMHeader

A Vue component.

**File:** `src/components/dm/DMHeader.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[DMHeader]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `conversation` | `DMConversation` | `undefined` | ✅ | No description |
| `isMobile` | `boolean` | `undefined` | ❌ | No description |

### Props Details

#### `conversation`

No description available.

- **Type:** `DMConversation`
- **Required:** Yes
- **Default:** `undefined`



#### `isMobile`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `toggle-left-sidebar` | unknown | No description |
| `add-user` | unknown | No description |
| `toggle-voice-panel` | unknown | No description |
| `group-updated` | unknown | No description |
| `incoming-call` | { callerId: string, callType: 'voice' | 'video', conversationId: string } | No description |

### Event Details

#### `toggle-left-sidebar`

No description available.

**Parameters:** `unknown`



#### `add-user`

No description available.

**Parameters:** `unknown`



#### `toggle-voice-panel`

No description available.

**Parameters:** `unknown`



#### `group-updated`

No description available.

**Parameters:** `unknown`



#### `incoming-call`

No description available.

**Parameters:** `{ callerId: string, callType: 'voice' | 'video', conversationId: string }`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <DMHeader
    :conversation="undefined"
    @toggle-left-sidebar="handleToggle-left-sidebar"
    @add-user="handleAdd-user"
    @toggle-voice-panel="handleToggle-voice-panel"
    @group-updated="handleGroup-updated"
    @incoming-call="handleIncoming-call" />
</template>

<script setup lang="ts">
const handleToggle-left-sidebar = (data) => {
  // Handle toggle-left-sidebar event
}

const handleAdd-user = (data) => {
  // Handle add-user event
}

const handleToggle-voice-panel = (data) => {
  // Handle toggle-voice-panel event
}

const handleGroup-updated = (data) => {
  // Handle group-updated event
}

const handleIncoming-call = ({ callerId: string, callType: 'voice' | 'video', conversationId: string }) => {
  // Handle incoming-call event
}
</script>
```



## File Location

`src/components/dm/DMHeader.vue`

---

*This documentation was automatically generated from the component source code.*