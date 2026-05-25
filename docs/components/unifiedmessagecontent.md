# UnifiedMessageContent

A Vue component.

**File:** `src/components/UnifiedMessageContent.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[UnifiedMessageContent]
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
| `imageLoaded` | `Record<string, boolean>` | `() => ({})` | ❌ | No description |
| `isSingleEmoji` | `boolean` | `false` | ❌ | No description |
| `editableContent` | `string` | `''` | ❌ | No description |
| `isSystem` | `boolean` | `false` | ❌ | No description |
| `embedPayloads` | `Record<string, EmbedPayload> | null` | `null` | ❌ | No description |
| `encrypted` | `boolean` | `false` | ❌ | No description |
| `decrypted` | `boolean` | `false` | ❌ | No description |
| `canDecrypt` | `boolean` | `false` | ❌ | No description |

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
- **Default:** `() => ({})`



#### `isSingleEmoji`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `editableContent`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `''`



#### `isSystem`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `embedPayloads`

No description available.

- **Type:** `Record<string, EmbedPayload> | null`
- **Required:** No
- **Default:** `null`



#### `encrypted`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `decrypted`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `canDecrypt`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `open-lightbox` | `unknown` | No description |
| `show-user-profile` | `unknown` | No description |
| `update:message` | `unknown` | No description |
| `update:content` | `unknown` | No description |
| `cancel-edit` | `unknown` | No description |
| `image-loaded` | `unknown` | No description |
| `embed-loaded` | `unknown` | No description |
| `hashtag-click` | `unknown` | No description |
| `decrypt-message` | `unknown` | No description |

### Event Details

#### `open-lightbox`

No description available.

**Parameters:** `unknown`



#### `show-user-profile`

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



#### `image-loaded`

No description available.

**Parameters:** `unknown`



#### `embed-loaded`

No description available.

**Parameters:** `unknown`



#### `hashtag-click`

No description available.

**Parameters:** `unknown`



#### `decrypt-message`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <UnifiedMessageContent
    :content="undefined"
    :messageId=""example""
    @open-lightbox="handleOpenLightbox"
    @show-user-profile="handleShowUserProfile"
    @update:message="handleUpdate:message"
    @update:content="handleUpdate:content"
    @cancel-edit="handleCancelEdit"
    @image-loaded="handleImageLoaded"
    @embed-loaded="handleEmbedLoaded"
    @hashtag-click="handleHashtagClick"
    @decrypt-message="handleDecryptMessage" />
</template>

<script setup lang="ts">
const handleOpenLightbox = (data: unknown) => {
  // Handle open-lightbox event
}

const handleShowUserProfile = (data: unknown) => {
  // Handle show-user-profile event
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

const handleImageLoaded = (data: unknown) => {
  // Handle image-loaded event
}

const handleEmbedLoaded = (data: unknown) => {
  // Handle embed-loaded event
}

const handleHashtagClick = (data: unknown) => {
  // Handle hashtag-click event
}

const handleDecryptMessage = (data: unknown) => {
  // Handle decrypt-message event
}
</script>
```



## File Location

`src/components/UnifiedMessageContent.vue`

---

*This documentation was automatically generated from the component source code.*