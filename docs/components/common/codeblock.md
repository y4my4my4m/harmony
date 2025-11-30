# CodeBlock

A Vue component.

**File:** `src/components/common/CodeBlock.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[CodeBlock]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `code` | `string` | `undefined` | ✅ | No description |
| `language` | `string` | `'text'` | ❌ | No description |

### Props Details

#### `code`

No description available.

- **Type:** `string`
- **Required:** Yes
- **Default:** `undefined`



#### `language`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `'text'`




## Events

This component emits no events.

## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <CodeBlock
    :code=""example"" />
</template>

<script setup lang="ts">
// No event handlers needed
</script>
```



## File Location

`src/components/common/CodeBlock.vue`

---

*This documentation was automatically generated from the component source code.*