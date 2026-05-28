# ServerAdvancedSettings

A Vue component.

**File:** `src/components/settings/ServerAdvancedSettings.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ServerAdvancedSettings]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `serverId` | `string` | `undefined` | ✅ | No description |
| `serverName` | `string` | `undefined` | ✅ | No description |
| `createdAt` | `union` | `undefined` | ✅ | No description |
| `loading` | `boolean` | `undefined` | ✅ | No description |
| `permissions` | `ServerAdvancedPermissions` | `undefined` | ✅ | No description |

### Props Details

#### `serverId`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `serverName`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `createdAt`

No description available.

- **Type:** `union`
- **Required:** Yes
- **Default:** `undefined`



#### `loading`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`



#### `permissions`

No description available.

- **Type:** `ServerAdvancedPermissions`
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
  <ServerAdvancedSettings
    :serverId=""example""
    :serverName=""example""
    :createdAt="undefined"
    :loading="true"
    :permissions="undefined" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/settings/ServerAdvancedSettings.vue`

---

*This documentation was automatically generated from the component source code.*