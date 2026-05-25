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
| `show-user-profile` | `unknown` | No description |
| `image-loaded` | `unknown` | No description |
| `open-lightbox` | `unknown` | No description |
| `update:message` | `unknown` | No description |
| `update:content` | `unknown` | No description |
| `cancel-edit` | `unknown` | No description |

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
    @show-user-profile="handleShowUserProfile"
    @image-loaded="handleImageLoaded"
    @open-lightbox="handleOpenLightbox"
    @update:message="handleUpdate:message"
    @update:content="handleUpdate:content"
    @cancel-edit="handleCancelEdit" />
</template>

<script setup lang="ts">
const handleShowUserProfile = (data: unknown) => {
  // Handle show-user-profile event
}

const handleImageLoaded = (data: unknown) => {
  // Handle image-loaded event
}

const handleOpenLightbox = (data: unknown) => {
  // Handle open-lightbox event
}

const handleUpdate:message = (data: unknown) => {
  // Handle update:message event
}

const handleUpdate:content = (data: unknown) => {
  // Handle update:content event
}

const handleCancelEdit = (data: unknown) => {
  // Handle cancel-edit event
}
</script>
```



## File Location

`src/components/MessageContent.vue`

---

*This documentation was automatically generated from the component source code.*