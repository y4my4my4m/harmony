# UnifiedButton

A Vue component.

**File:** `src/components/shared/UnifiedButton.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[UnifiedButton]
    COMPONENT --> EVENTS[Events]
    COMPONENT --> SLOTS[Slots]
    EVENTS --> PARENT[Parent Component]
    SLOTS --> CONTENT[Slot Content]
```

## Props

| Name | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `text` | `string` | `undefined` | ❌ | No description |
| `ariaLabel` | `string` | `undefined` | ❌ | No description |
| `variant` | `union` | `'secondary'` | ❌ | No description |
| `size` | `union` | `'md'` | ❌ | No description |
| `iconLeft` | `any` | `undefined` | ❌ | No description |
| `iconRight` | `any` | `undefined` | ❌ | No description |
| `iconOnly` | `boolean` | `undefined` | ❌ | No description |
| `disabled` | `boolean` | `undefined` | ❌ | No description |
| `loading` | `boolean` | `undefined` | ❌ | No description |
| `active` | `boolean` | `undefined` | ❌ | No description |
| `rounded` | `boolean` | `undefined` | ❌ | No description |
| `fullWidth` | `boolean` | `undefined` | ❌ | No description |
| `outline` | `boolean` | `undefined` | ❌ | No description |
| `tag` | `union` | `'button'` | ❌ | No description |
| `type` | `union` | `'button'` | ❌ | No description |
| `href` | `string` | `undefined` | ❌ | No description |
| `to` | `union` | `undefined` | ❌ | No description |
| `badge` | `union` | `undefined` | ❌ | No description |
| `tooltip` | `string` | `undefined` | ❌ | No description |

### Props Details

#### `text`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `ariaLabel`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `variant`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `'secondary'`



#### `size`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `'md'`



#### `iconLeft`

No description available.

- **Type:** `any`
- **Required:** No
- **Default:** `undefined`



#### `iconRight`

No description available.

- **Type:** `any`
- **Required:** No
- **Default:** `undefined`



#### `iconOnly`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`



#### `disabled`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`



#### `loading`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`



#### `active`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`



#### `rounded`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`



#### `fullWidth`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`



#### `outline`

No description available.

- **Type:** `boolean`
- **Required:** No
- **Default:** `undefined`



#### `tag`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `'button'`



#### `type`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `'button'`



#### `href`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`



#### `to`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `undefined`



#### `badge`

No description available.

- **Type:** `union`
- **Required:** No
- **Default:** `undefined`



#### `tooltip`

No description available.

- **Type:** `string`
- **Required:** No
- **Default:** `undefined`




## Events

| Name | Parameters | Description |
|------|------------|-------------|
| `click` | `Event` | No description |

### Event Details

#### `click`

No description available.

**Parameters:** `Event`




## Slots

| Name | Scoped | Description |
|------|--------|-------------|
| `default` | ❌ | No description |

### Slot Details

#### `default`

No description available.

**Scoped:** No




## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <UnifiedButton
    
    @click="handleClick">
    <template #default>
      <!-- Slot content for default -->
    </template>
  </UnifiedButton>
</template>

<script setup lang="ts">
const handleClick = (data: Event) => {
  // Handle click event
}
</script>
```



## File Location

`src/components/shared/UnifiedButton.vue`

---

*This documentation was automatically generated from the component source code.*