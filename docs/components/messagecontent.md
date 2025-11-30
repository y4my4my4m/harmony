# MessageContent

A Vue component.

**File:** `src/components/MessageContent.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[MessageContent]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `content` | `MessagePart[]` | `undefined` | ✅ | No description |
| `editableMessageId` | `string | null` | `null` | ❌ | No description |
| `messageId` | `string` | `undefined` | ✅ | No description |
| `imageLoaded` | `Record<string, boolean>` | `undefined` | ❌ | No description |
| `isSingleEmojiMessage` | `boolean` | `undefined` | ❌ | No description |
| `editableMessageContent` | `string` | `''` | ❌ | No description |
| `saveEdit` | `func` | `undefined` | ❌ | No description |
| `cancelEdit` | `func` | `undefined` | ❌ | No description |
| `showUserProfile` | `func` | `undefined` | ❌ | No description |
| `reply` | `boolean` | `undefined` | ❌ | No description |

### Props Details

#### `content`

No description available.

- **Type:** `MessagePart[]`
- **Required:** Yes
- **Default:** `undefined`



#### `editableMessageId`

No description available.

- **Type:** `string | null`
- **Required:** No
- **Default:** `null`



#### `messageId`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `imageLoaded`

No description available.

- **Type:** `Record<string, boolean>`
- **Required:** No
- **Default:** `undefined`



#### `isSingleEmojiMessage`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`



#### `editableMessageContent`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `''`



#### `saveEdit`

No description available.

- **Type:** `func`
- **Required:** No
- **Default:** `undefined`



#### `cancelEdit`

No description available.

- **Type:** `func`
- **Required:** No
- **Default:** `undefined`



#### `showUserProfile`

No description available.

- **Type:** `func`
- **Required:** No
- **Default:** `undefined`



#### `reply`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `show-user-profile` | unknown | No description |
| `image-loaded` | unknown | No description |
| `open-lightbox` | unknown | No description |
| `update:message` | unknown | No description |
| `update:content` | unknown | No description |
| `cancel-edit` | unknown | No description |

### Event Details

#### `show-user-profile`

No description available.

**Parameters:** `unknown`



#### `image-loaded`

No description available.

**Parameters:** `unknown`



#### `open-lightbox`

No description available.

**Parameters:** `unknown`



#### `update:message`

No description available.

**Parameters:** `unknown`



#### `update:content`

No description available.

**Parameters:** `unknown`



#### `cancel-edit`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <MessageContent
    :content="undefined"
    :messageId=""example""
    @show-user-profile="handleShow-user-profile"
    @image-loaded="handleImage-loaded"
    @open-lightbox="handleOpen-lightbox"
    @update:message="handleUpdate:message"
    @update:content="handleUpdate:content"
    @cancel-edit="handleCancel-edit" />
</template>

<script setup lang="ts">
const handleShow-user-profile = (data) => {
  // Handle show-user-profile event
}

const handleImage-loaded = (data) => {
  // Handle image-loaded event
}

const handleOpen-lightbox = (data) => {
  // Handle open-lightbox event
}

const handleUpdate:message = (data) => {
  // Handle update:message event
}

const handleUpdate:content = (data) => {
  // Handle update:content event
}

const handleCancel-edit = (data) => {
  // Handle cancel-edit event
}
</script>
```



## File Location

`src/components/MessageContent.vue`

---

*This documentation was automatically generated from the component source code.*