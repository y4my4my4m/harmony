<!--
  AppDialog - modal dialog shell over useDialog: Teleport to <body>, a click-to-close
  overlay, and the dialog element with role, aria-modal and labelling. Styling of
  the panel stays with the consumer: attributes (class, style, data-testid) land on
  the dialog element.

    <AppDialog :open="show" :label="t('pins.title')" class="pinned-popup" @close="show = false">
      ...
    </AppDialog>

    <AppDialog :open="show" class="my-panel" @close="close" v-slot="{ titleId }">
      <h2 :id="titleId">{{ t('lists.edit') }}</h2>
    </AppDialog>

  Name: `label` (aria-label), else `labelledby`, else the slot's `titleId`, which
  the consumer puts on its heading. `describedby` defaults to nothing; the slot's
  `descriptionId` is there for a description paragraph.
  Overlay: fixed, centred, z-index var(--app-dialog-z, 1000); `overlay-class`
  restyles it. `@close` carries 'escape' or 'overlay'.
-->
<template>
  <Teleport to="body" :disabled="!teleport">
    <div
      v-if="open"
      class="app-dialog-overlay"
      :class="overlayClass"
      data-dialog-overlay
      @mousedown.self="pressedOverlay = true"
      @click.self="onOverlayClick"
    >
      <div
        ref="dialogEl"
        v-bind="$attrs"
        :role="role"
        aria-modal="true"
        :aria-label="label || undefined"
        :aria-labelledby="label ? undefined : (labelledby || titleId)"
        :aria-describedby="describedby || undefined"
        tabindex="-1"
      >
        <slot :title-id="titleId" :description-id="descriptionId" :close="() => emit('close', 'escape')" />
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDialog, type InitialFocus } from '@/composables/useDialog'

defineOptions({ inheritAttrs: false })

interface Props {
  open: boolean
  label?: string
  labelledby?: string
  describedby?: string
  role?: 'dialog' | 'alertdialog'
  closeOnOverlay?: boolean
  closeOnEscape?: boolean
  initialFocus?: InitialFocus
  overlayClass?: string | string[] | Record<string, boolean>
  teleport?: boolean
  /** False keeps the page behind scrollable and interactive (non-modal sheets). */
  modal?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  role: 'dialog',
  closeOnOverlay: true,
  closeOnEscape: true,
  initialFocus: 'auto',
  teleport: true,
  modal: true,
})

const emit = defineEmits<{ close: [reason: 'escape' | 'overlay'] }>()

const dialogEl = ref<HTMLElement | null>(null)
// A drag that starts inside the panel and ends on the overlay is not a click on it.
const pressedOverlay = ref(false)

const { titleId, descriptionId } = useDialog({
  open: () => props.open,
  element: dialogEl,
  onClose: () => emit('close', 'escape'),
  closeOnEscape: () => props.closeOnEscape,
  initialFocus: () => props.initialFocus,
  inertBackground: props.modal,
  lockScroll: props.modal,
})

function onOverlayClick() {
  const pressed = pressedOverlay.value
  pressedOverlay.value = false
  if (pressed && props.closeOnOverlay) emit('close', 'overlay')
}

defineExpose({ element: dialogEl, titleId, descriptionId })
</script>

<style>
.app-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--app-dialog-z, 1000);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(0, 0, 0, 0.6);
}

.app-dialog-overlay > [role='dialog']:focus,
.app-dialog-overlay > [role='alertdialog']:focus {
  outline: none;
}

.app-dialog-overlay > [role='dialog']:focus-visible,
.app-dialog-overlay > [role='alertdialog']:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}
</style>
