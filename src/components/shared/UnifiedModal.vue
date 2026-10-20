<!--
  UnifiedModal - v-model modal with optional header, footer and action buttons.
  Dialog semantics, focus, Escape (topmost dialog only) and the inert background
  come from composables/useDialog.ts.
  Name: `title`, else `ariaLabel`, else the first heading inside the modal.
-->
<template>
  <Teleport :to="portalTarget">
    <Transition
      name="modal"
      enter-active-class="modal-enter-active"
      leave-active-class="modal-leave-active"
      enter-from-class="modal-enter-from"
      leave-to-class="modal-leave-to"
    >
      <div
        v-if="modelValue"
        class="modal-overlay"
        :class="{ 'modal-overlay--topmost': topmost }"
        @click="handleOverlayClick"
      >
        <div
          ref="containerRef"
          class="modal-container"
          :class="[
            `modal-${size}`,
            { 
              'modal-full-height': fullHeight,
              'modal-profile': isProfile,
              'modal-no-padding': noPadding
            },
            containerClass
          ]"
          :role="role"
          aria-modal="true"
          :aria-labelledby="labelledBy"
          :aria-label="labelledBy ? undefined : ariaLabel"
          :aria-describedby="describedby || (subtitle && !hideHeader && !$slots.customHeader ? descriptionId : undefined)"
          tabindex="-1"
          @click.stop
        >
          <!-- Custom Header Slot (for profile banners, etc.) -->
          <div v-if="$slots.customHeader" class="modal-custom-header">
            <slot name="customHeader" />
          </div>

          <!-- Header with optional icon -->
          <div v-if="!hideHeader && !$slots.customHeader" class="modal-header">
            <div class="modal-header-content">
              <!-- Icon slot or component -->
              <div v-if="icon || $slots.icon" class="modal-icon" aria-hidden="true">
                <slot name="icon">
                  <component :is="icon" v-if="icon" />
                </slot>
              </div>
              
              <!-- Title and subtitle -->
              <div class="modal-title-section">
                <h2 v-if="title" :id="titleId" class="modal-title">{{ title }}</h2>
                <p v-if="subtitle" :id="descriptionId" class="modal-subtitle">{{ subtitle }}</p>
                <slot name="header-content" />
              </div>
            </div>
            
            <!-- Close button -->
            <button
              v-if="showCloseButton"
              type="button"
              class="modal-close"
              @click="handleClose"
              :aria-label="closeButtonLabel || t('common.close')"
              :title="closeButtonLabel || t('common.close')"
            >
              <svg class="modal-close-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" fill="currentColor"/>
              </svg>
            </button>
          </div>

          <!-- Content area -->
          <div class="modal-body custom-scrollbar" :class="{ 'no-padding': noPadding }">
            <slot />
          </div>

          <!-- Footer with actions -->
          <div v-if="$slots.footer || actions?.length" class="modal-footer">
            <slot name="footer">
              <!-- Default action buttons -->
              <div v-if="actions?.length" class="modal-actions">
                <button
                  v-for="action in actions"
                  :key="action.key"
                  type="button"
                  class="btn"
                  :class="action.variant ? `btn-${action.variant}` : 'btn-secondary'"
                  :disabled="action.disabled || action.loading"
                  :aria-busy="action.loading || undefined"
                  @click="handleAction(action)"
                >
                  <div v-if="action.loading" class="spinner" aria-hidden="true"></div>
                  <component v-if="action.icon && !action.loading" :is="action.icon" aria-hidden="true" />
                  {{ action.label }}
                </button>
              </div>
            </slot>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, useSlots, watch } from 'vue'
import { useT } from '@/composables/useT'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { useDialog, type InitialFocus } from '@/composables/useDialog'
import { usePortalTarget } from '@/composables/usePortalTarget'

const portalTarget = usePortalTarget()

export interface ModalAction {
  key: string
  label: string
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'ghost'
  icon?: any
  disabled?: boolean
  loading?: boolean
  handler: () => void | Promise<void>
}

interface Props {
  modelValue: boolean
  title?: string
  subtitle?: string
  icon?: any
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  fullHeight?: boolean
  hideHeader?: boolean
  showCloseButton?: boolean
  closeOnOverlay?: boolean
  closeOnEscape?: boolean
  persistent?: boolean
  containerClass?: string
  actions?: ModalAction[]
  closeButtonLabel?: string
  isProfile?: boolean
  noPadding?: boolean
  /** Above full-screen sheets and context menus (z-index 10001-10006). */
  topmost?: boolean
  /** Accessible name when there is no visible title. */
  ariaLabel?: string
  /** Id of the element describing the dialog; default: the subtitle. */
  describedby?: string
  initialFocus?: InitialFocus
  role?: 'dialog' | 'alertdialog'
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void
  (e: 'close'): void
  (e: 'open'): void
  (e: 'action', action: ModalAction): void
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  showCloseButton: true,
  closeOnOverlay: true,
  closeOnEscape: true,
  persistent: false,
  initialFocus: 'auto',
  role: 'dialog',
})

const emit = defineEmits<Emits>()
const { t } = useT()

const containerRef = ref<HTMLElement>()

const handleClose = () => {
  if (props.persistent) return
  
  emit('update:modelValue', false)
  emit('close')
}

const { titleId, descriptionId, isActive } = useDialog({
  open: () => props.modelValue,
  element: containerRef,
  onClose: handleClose,
  closeOnEscape: () => props.closeOnEscape && !props.persistent,
  initialFocus: () => props.initialFocus,
})

// Without a visible title, the first heading inside names the dialog.
const contentHeadingId = ref<string | undefined>()
watch(isActive, (active) => {
  if (!active || props.title || props.ariaLabel) return
  const heading = containerRef.value?.querySelector<HTMLElement>('h1, h2, h3')
  if (!heading) return
  if (!heading.id) heading.id = `${titleId}-content`
  contentHeadingId.value = heading.id
})

const slots = useSlots()
const labelledBy = computed(() => {
  // customHeader replaces the titled header.
  if (props.title && !props.hideHeader && !slots.customHeader) return titleId
  if (props.ariaLabel) return undefined
  return contentHeadingId.value
})

const handleOverlayClick = () => {
  if (props.closeOnOverlay && !props.persistent) {
    handleClose()
  }
}

const toast = useToast()
const handleAction = async (action: ModalAction) => {
  try {
    await action.handler()
    emit('action', action)
  } catch (error: any) {
    debug.error('Modal action error:', error)
    const msg = error?.message || t('a11y.genericError')
    toast.error(msg)
  }
}

watch(() => props.modelValue, (isOpen) => {
  if (isOpen) emit('open')
})
</script>

<style scoped>
.modal-overlay.modal-overlay--topmost {
  z-index: 10010;
}

/* Use design system variables */
.modal-enter-active,
.modal-leave-active {
  transition: all var(--transition-base);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
  transform: translateY(32px) scale(0.95);
}

/* Modal sizes */
.modal-sm {
  max-width: 400px;
}

.modal-md {
  max-width: 540px;
}

.modal-lg {
  max-width: 720px;
}

.modal-xl {
  max-width: 960px;
}

.modal-full {
  max-width: calc(95 * var(--app-vw));
  max-height: calc(95 * var(--app-vh));
}

.modal-full-height {
  height: calc(90 * var(--app-vh));
}

.modal-full-height .modal-body {
  flex: 1;
  min-height: 0;
}

.modal-header {
  flex-shrink: 0;
}

.modal-footer {
  flex-shrink: 0;
}

.modal-header-content {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex: 1;
  min-width: 0;
}

.modal-icon {
  width: 48px;
  height: 48px;
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-link);
  flex-shrink: 0;
}

.modal-icon :deep(svg) {
  width: 24px;
  height: 24px;
}

.modal-title-section {
  flex: 1;
  min-width: 0;
}

.modal-close-icon {
  width: 18px;
  height: 18px;
}

.modal-actions {
  display: flex;
  gap: var(--space-3);
  justify-content: flex-end;
  flex-wrap: wrap;
}

/* Full height layout for complex modals */
.modal-full-height {
  display: flex;
  flex-direction: column;
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .modal-sm,
  .modal-md,
  .modal-lg,
  .modal-xl {
    max-width: calc(95 * var(--app-vw));
    margin: 0 var(--space-2);
  }
  
  .modal-full {
    max-width: calc(100 * var(--app-vw));
    max-height: calc(100 * var(--app-vh));
    margin: 0;
    border-radius: 0;
  }
  
  .modal-actions {
    flex-direction: column-reverse;
  }
  
  .modal-actions .btn {
    width: 100%;
    justify-content: center;
  }
}

.modal-container {
  transform-origin: center;
  will-change: transform, opacity;
  background: var(--background-primary);
}

/* Focus management */
.modal-container:focus {
  outline: none;
}

/* Enhanced loading state */
.modal-body.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}

/* Scrollable content */
.modal-body {
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* Profile modal customizations */
.modal-profile {
  overflow: hidden;
}

.modal-custom-header {
  position: relative;
  flex-shrink: 0;
}

.modal-body.no-padding {
  padding: 0;
}

.modal-no-padding .modal-body {
  padding: 0;
}

/* Better contrast for accessibility */
@media (prefers-contrast: high) {
  .modal-container {
    border-width: 2px;
  }
  
  .modal-close {
    border-width: 2px;
  }
}

/* Reduced motion support */
@media (prefers-reduced-motion: reduce) {
  .modal-enter-active,
  .modal-leave-active {
    transition-duration: 0.01ms;
  }
  
  .modal-container {
    transform: none !important;
  }
}
</style>