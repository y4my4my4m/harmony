# LanguageSettings

A Vue component.

**File:** `src/components/settings/user/LanguageSettings.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[LanguageSettings]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `loading` | `boolean` | `undefined` | ✅ | No description |

### Props Details

#### `loading`

No description available.

- **Type:** `boolean`
- **Required:** Yes
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `update-language` | `string` | No description |

### Event Details

#### `update-language`

No description available.

**Parameters:** `string`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <LanguageSettings
    :loading="true"
    @update-language="handleUpdateLanguage" />
</template>

<script setup lang="ts">
const handleUpdateLanguage = (data: string) => {
  // Handle update-language event
}
</script>
```



## File Location

`src/components/settings/user/LanguageSettings.vue`

---

*This documentation was automatically generated from the component source code.*