# ServerEncryptionSettings

A Vue component.

**File:** `src/components/settings/ServerEncryptionSettings.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ServerEncryptionSettings]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `serverId` | `string` | `undefined` | ✅ | No description |

### Props Details

#### `serverId`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`




## Events

This component emits no events.

## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ServerEncryptionSettings
    :serverId=""example"" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/settings/ServerEncryptionSettings.vue`

---

*This documentation was automatically generated from the component source code.*