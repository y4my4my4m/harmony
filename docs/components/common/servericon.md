# ServerIcon

A Vue component.

**File:** `src/components/common/ServerIcon.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[ServerIcon]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `id` | `string` | `undefined` | ❌ | No description |
| `src` | `union` | `undefined` | ❌ | No description |
| `alt` | `string` | `'server'` | ❌ | No description |
| `classes` | `Array` | `undefined` | ❌ | No description |
| `size` | `serverSize` | `'md'` | ❌ | No description |
| `status` | `UserStatus` | `undefined` | ❌ | No description |
| `editable` | `boolean` | `false` | ❌ | No description |
| `interactive` | `boolean` | `false` | ❌ | No description |
| `loading` | `boolean` | `false` | ❌ | No description |
| `shape` | `ImageShape` | `'rounded'` | ❌ | No description |
| `showTitle` | `boolean` | `true` | ❌ | No description |

### Props Details

#### `id`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `src`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `undefined`



#### `alt`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `'server'`



#### `classes`

No description available.

- **Type:** `Array`
- **Required:** No
- **Default:** `undefined`



#### `size`

No description available.

- **Type:** `serverSize`
- **Required:** No
- **Default:** `'md'`



#### `status`

No description available.

- **Type:** `UserStatus`
- **Required:** No
- **Default:** `undefined`



#### `editable`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `interactive`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `loading`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `shape`

No description available.

- **Type:** `ImageShape`
- **Required:** No
- **Default:** `'rounded'`



#### `showTitle`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `true`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `click` | `string` | No description |
| `upload` | `File` | No description |
| `edit` | `unknown` | No description |

### Event Details

#### `click`

No description available.

**Parameters:** `string`



#### `upload`

No description available.

**Parameters:** `File`



#### `edit`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <ServerIcon
    
    @click="handleClick"
    @upload="handleUpload"
    @edit="handleEdit" />
</template>

<script setup lang="ts">
const handleClick = (data: string) => {
  // Handle click event
}

const handleUpload = (data: File) => {
  // Handle upload event
}

const handleEdit = (data: unknown) => {
  // Handle edit event
}
</script>
```



## File Location

`src/components/common/ServerIcon.vue`

---

*This documentation was automatically generated from the component source code.*