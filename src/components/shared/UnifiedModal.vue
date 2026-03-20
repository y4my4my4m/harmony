<template>
  <Teleport to="body">
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
        @click="handleOverlayClick"
        @keydown.esc="handleEscape"
        tabindex="-1"
        ref="overlayRef"
      >
        <div
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
          @click.stop
          ref="containerRef"
        >
          <!-- Custom Header Slot (for profile banners, etc.) -->
          <div v-if="$slots.customHeader" class="modal-custom-header">
            <slot name="customHeader" />
          </div>

          <!-- Header with optional icon -->
          <header v-if="!hideHeader && !$slots.customHeader" class="modal-header">
            <div class="modal-header-content">
              <!-- Icon slot or component -->
              <div v-if="icon || $slots.icon" class="modal-icon">
                <slot name="icon">
                  <component :is="icon" v-if="icon" />
                </slot>
              </div>
              
              <!-- Title and subtitle -->
              <div class="modal-title-section">
                <h2 v-if="title" class="modal-title">{{ title }}</h2>
                <p v-if="subtitle" class="modal-subtitle">{{ subtitle }}</p>
                <slot name="header-content" />
              </div>
            </div>
            
            <!-- Close button -->
            <button
              v-if="showCloseButton"
              class="modal-close"
              @click="handleClose"
              :aria-label="closeButtonLabel"
            >
              <svg class="modal-close-icon" viewBox="0 0 24 24">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" fill="currentColor"/>
              </svg>
            </button>
          </header>

          <!-- Main content area -->
          <main class="modal-body custom-scrollbar" :class="{ 'no-padding': noPadding }">
            <slot />
          </main>

          <!-- Footer with actions -->
          <footer v-if="$slots.footer || actions?.length" class="modal-footer">
            <slot name="footer">
              <!-- Default action buttons -->
              <div v-if="actions?.length" class="modal-actions">
                <button
                  v-for="action in actions"
                  :key="action.key"
                  class="btn"
                  :class="action.variant ? `btn-${action.variant}` : 'btn-secondary'"
                  :disabled="action.disabled || action.loading"
                  @click="handleAction(action)"
                >
                  <div v-if="action.loading" class="spinner"></div>
                  <component v-if="action.icon && !action.loading" :is="action.icon" />
                  {{ action.label }}
                </button>
              </div>
            </slot>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'

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
  closeButtonLabel: 'Close modal'
})

const emit = defineEmits<Emits>()

const overlayRef = ref<HTMLElement>()
const containerRef = ref<HTMLElement>()
const previousActiveElement = ref<HTMLElement>()

// Handle modal opening
const handleOpen = () => {
  // Store previously focused element
  previousActiveElement.value = document.activeElement as HTMLElement
  
  // Prevent body scroll
  document.body.style.overflow = 'hidden'
  
  // Focus the modal for accessibility
  nextTick(() => {
    overlayRef.value?.focus()
  })
  
  emit('open')
}

// Handle modal closing
const handleClose = () => {
  if (props.persistent) return
  
  emit('update:modelValue', false)
  emit('close')
}

// Handle overlay click
const handleOverlayClick = () => {
  if (props.closeOnOverlay && !props.persistent) {
    handleClose()
  }
}

// Handle escape key
const handleEscape = () => {
  if (props.closeOnEscape && !props.persistent) {
    handleClose()
  }
}

// Handle action button clicks
const toast = useToast()
const handleAction = async (action: ModalAction) => {
  try {
    await action.handler()
    emit('action', action)
  } catch (error: any) {
    debug.error('Modal action error:', error)
    const msg = error?.message || 'Something went wrong. Please try again.'
    toast.error(msg)
  }
}

// Watch for modal value changes
watch(() => props.modelValue, (isOpen) => {
  if (isOpen) {
    handleOpen()
  } else {
    // Restore body scroll
    document.body.style.overflow = ''
    
    // Restore focus
    if (previousActiveElement.value) {
      previousActiveElement.value.focus()
    }
  }
})

// Handle keyboard navigation for accessibility
const handleKeydown = (event: KeyboardEvent) => {
  if (!props.modelValue) return
  
  // Trap focus within modal
  if (event.key === 'Tab') {
    const focusableElements = containerRef.value?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    
    if (focusableElements && focusableElements.length > 0) {
      const firstElement = focusableElements[0] as HTMLElement
      const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement
      
      if (event.shiftKey) {
        if (document.activeElement === firstElement) {
          event.preventDefault()
          lastElement.focus()
        }
      } else {
        if (document.activeElement === lastElement) {
          event.preventDefault()
          firstElement.focus()
        }
      }
    }
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  // Ensure body scroll is restored
  document.body.style.overflow = ''
})
</script>

<style scoped>
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
  max-width: 95vw;
  max-height: 95vh;
}

.modal-full-height {
  height: 90vh;
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
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
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
    max-width: 95vw;
    margin: 0 var(--space-2);
  }
  
  .modal-full {
    max-width: 100vw;
    max-height: 100vh;
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

/* Animation improvements for better UX */
.modal-container {
  transform-origin: center;
  will-change: transform, opacity;
  background: var(--background-primary-alpha);
}

/* Focus management */
.modal-overlay:focus {
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