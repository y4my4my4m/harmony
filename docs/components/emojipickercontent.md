# EmojiPickerContent

A Vue component.

**File:** `src/components/EmojiPickerContent.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[EmojiPickerContent]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

This component has no props.

## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `sendEmoji` | `Emoji` | No description |

### Event Details

#### `sendEmoji`

No description available.

**Parameters:** `Emoji`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <EmojiPickerContent
    @sendEmoji="handleSendEmoji" />
</template>

<script setup lang="ts">
const handleSendEmoji = (data: Emoji) => {
  // Handle sendEmoji event
}
</script>
```



## File Location

`src/components/EmojiPickerContent.vue`

---

*This documentation was automatically generated from the component source code.*