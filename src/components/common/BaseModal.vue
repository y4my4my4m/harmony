<template>
  <Teleport to="body">
    <div v-if="show" :class="['modal-overlay', overlayClass]" @click="handleOverlayClick">
      <div
        class="modal-container"
        @click.stop
        :class="{ 'modal-compact': compact }"
      >
        <div v-if="backgroundImage" class="modal-bg" aria-hidden="true">
          <div class="modal-bg__image" :style="{ backgroundImage: `url(${backgroundImage})` }"></div>
          <div class="modal-bg__scrim"></div>
        </div>
        <!-- Header -->
        <div class="modal-header" v-if="showHeader">
          <div class="header-content">
            <div class="icon-container" v-if="icon">
              <Icon v-if="typeof icon === 'string'" :name="icon" class="modal-icon" :size="28" />
              <component v-else :is="icon" class="modal-icon" />
            </div>
            <div class="header-text">
              <h2 class="modal-title">{{ title }}</h2>
              <p class="modal-subtitle" v-if="subtitle">{{ subtitle }}</p>
            </div>
          </div>
          <button class="close-button" @click="$emit('close')" v-if="showCloseButton">
            <svg class="close-icon" viewBox="0 0 24 24">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" fill="currentColor"/>
            </svg>
          </button>
        </div>

        <!-- Content -->
        <div class="modal-content">
          <slot />
        </div>

        <!-- Footer -->
        <div class="modal-footer" v-if="$slots.footer">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'

interface Props {
  show: boolean
  title?: string
  subtitle?: string
  icon?: any
  compact?: boolean
  showHeader?: boolean
  showCloseButton?: boolean
  closeOnOverlay?: boolean
  /** Additional class for the overlay (e.g. "instance-detail-modal" for scoped child styles) */
  overlayClass?: string
  /** Blurred, darkened image layer behind the whole modal (e.g. server banner) */
  backgroundImage?: string | null
}

const props = withDefaults(defineProps<Props>(), {
  showHeader: true,
  showCloseButton: true,
  closeOnOverlay: true,
  compact: false
})

const emit = defineEmits<{
  close: []
}>()

const handleOverlayClick = () => {
  if (props.closeOnOverlay) {
    emit('close')
  }
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && props.show) {
    emit('close')
  }
}

watch(() => props.show, (visible) => {
  document.body.style.overflow = visible ? 'hidden' : ''
})

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  if (props.show) {
    document.body.style.overflow = 'hidden'
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.body.style.overflow = ''
})
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 1000;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.modal-container {
  background: var(--background-quinary);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-modal);
  width: 100%;
  max-width: 540px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}

@media (prefers-reduced-motion: no-preference) {
  .modal-overlay {
    animation: fadeIn 0.2s ease-out;
  }

  .modal-container {
    animation: slideUp 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
}

.modal-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

.modal-bg__image {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  /* over-scale so the blur doesn't reveal transparent edges */
  transform: scale(1.15);
  filter: blur(24px) saturate(1.1);
}

.modal-bg__scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--background-quinary) 72%, transparent);
}

.modal-header,
.modal-content,
.modal-footer {
  position: relative;
  z-index: 1;
}

.modal-compact {
  max-width: 460px;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 28px 32px 20px;
  border-bottom: 1px solid var(--border-secondary);
  flex-shrink: 0;
}

.header-content {
  display: flex;
  align-items: center;
  gap: 20px;
  flex: 1;
}

.icon-container {
  width: 56px;
  height: 56px;
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.modal-icon {
  width: 28px;
  height: 28px;
  color: var(--harmony-primary);
}

.header-text {
  flex: 1;
  min-width: 0;
}

.modal-title {
  font-size: var(--font-size-2xl);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 6px;
  line-height: 1.2;
}

.modal-subtitle {
  font-size: var(--font-size-base);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.3;
}

.close-button {
  width: 36px;
  height: 36px;
  background: transparent;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease;
  flex-shrink: 0;
}

.close-button:hover {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
}

.close-icon {
  width: 20px;
  height: 20px;
  color: var(--text-secondary);
  transition: color 0.2s ease;
}

.close-button:hover .close-icon {
  color: var(--text-primary);
}

.modal-content {
  padding: 24px 32px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  width: 100%;
  border-radius: 0;
}

.modal-footer {
  padding: 20px 32px 28px;
  border-top: 1px solid var(--border-secondary);
  background: rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
}

/* Scrollbar styling */
.modal-content::-webkit-scrollbar {
  width: 8px;
}

.modal-content::-webkit-scrollbar-track {
  background: transparent;
}

.modal-content::-webkit-scrollbar-thumb {
  background: var(--border-primary);
  border-radius: var(--radius-sm);
}

.modal-content::-webkit-scrollbar-thumb:hover {
  background: var(--border-hover);
}

/* Mobile responsive adjustments */
@media (max-width: 768px) {
  .modal-overlay {
    padding: 16px;
  }
  
  /* .modal-container {
    max-width: 100%;
    border-radius: 16px;
  } */
  
  .modal-header {
    padding: 24px 24px 16px;
  }
  
  .header-content {
    gap: 16px;
  }
  
  .icon-container {
    width: 48px;
    height: 48px;
    border-radius: var(--radius-md);
  }
  
  .modal-icon {
    width: 24px;
    height: 24px;
  }
  
  .modal-title {
    font-size: var(--font-size-xl);
  }
  
  .modal-subtitle {
    font-size: var(--font-size-sm);
  }
  
  .modal-content {
    padding: 20px 24px;
  }
  
  .modal-footer {
    padding: 16px 24px 24px;
  }
}
</style>