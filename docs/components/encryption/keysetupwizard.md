# KeySetupWizard

A Vue component.

**File:** `src/components/encryption/KeySetupWizard.vue`

## Overview

```mermaid
graph TB
    PROPS[Props] --> COMPONENT[KeySetupWizard]
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
| `close` | `unknown` | No description |
| `complete` | `unknown` | No description |

### Event Details

#### `close`

No description available.

**Parameters:** `unknown`



#### `complete`

No description available.

**Parameters:** `unknown`




## Slots

This component has no slots.

## Methods

This component exposes no public methods.

## Usage Example

```vue
<template>
  <KeySetupWizard
    @close="handleClose"
    @complete="handleComplete" />
</template>

<script setup lang="ts">
const handleClose = (data: unknown) => {
  // Handle close event
}

const handleComplete = (data: unknown) => {
  // Handle complete event
}
</script>
```



## File Location

`src/components/encryption/KeySetupWizard.vue`

---

*This documentation was automatically generated from the component source code.*