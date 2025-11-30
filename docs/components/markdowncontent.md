# MarkdownContent

A Vue component.

**File:** `src/components/MarkdownContent.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[MarkdownContent]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `content` | `string` | `undefined` | ✅ | No description |
| `singleLine` | `boolean` | `false` | ❌ | No description |
| `isReplyPreview` | `boolean` | `false` | ❌ | No description |
| `showMarkers` | `boolean` | `false` | ❌ | No description |

### Props Details

#### `content`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `singleLine`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `isReplyPreview`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`



#### `showMarkers`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `false`




## Events

This component emits no events.

## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <MarkdownContent
    :content=""example"" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/MarkdownContent.vue`

---

*This documentation was automatically generated from the component source code.*