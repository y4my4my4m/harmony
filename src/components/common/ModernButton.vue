<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :class="buttonClasses"
    @click="handleClick"
  >
    <!-- Loading spinner -->
    <div v-if="loading" class="button-spinner">
      <svg class="spinner" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="32" stroke-dashoffset="32">
          <animate attributeName="stroke-dashoffset" dur="1s" values="32;0;32" repeatCount="indefinite"/>
        </circle>
      </svg>
    </div>
    
    <!-- Icon (left) -->
    <component v-if="iconLeft && !loading" :is="iconLeft" class="button-icon icon-left" />
    
    <!-- Content -->
    <span v-if="!loading || showTextWhileLoading" class="button-content">
      <slot>{{ text }}</slot>
    </span>
    
    <!-- Icon (right) -->
    <component v-if="iconRight && !loading" :is="iconRight" class="button-icon icon-right" />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'ghost' | 'link'
  size?: 'small' | 'medium' | 'large'
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  loading?: boolean
  showTextWhileLoading?: boolean
  iconLeft?: any
  iconRight?: any
  text?: string
  fullWidth?: boolean
  rounded?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  size: 'medium',
  type: 'button',
  disabled: false,
  loading: false,
  showTextWhileLoading: false,
  fullWidth: false,
  rounded: false
})

const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

const buttonClasses = computed(() => [
  'modern-button',
  `button-${props.variant}`,
  `button-${props.size}`,
  {
    'button-disabled': props.disabled,
    'button-loading': props.loading,
    'button-full-width': props.fullWidth,
    'button-rounded': props.rounded,
    'button-icon-only': !props.text && !$slots.default && (props.iconLeft || props.iconRight)
  }
])

const handleClick = (event: MouseEvent) => {
  if (!props.disabled && !props.loading) {
    emit('click', event)
  }
}
</script>

<style scoped>
.modern-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-family: inherit;
  font-weight: 500;
  font-size: 14px;
  line-height: 1;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  text-decoration: none;
  user-select: none;
  position: relative;
  overflow: hidden;
  outline: none;
  white-space: nowrap;
}

.modern-button:focus-visible {
  outline: 2px solid #5865f2;
  outline-offset: 2px;
}

/* Sizes */
.button-small {
  padding: 6px 12px;
  font-size: 12px;
  min-height: 28px;
}

.button-medium {
  padding: 10px 16px;
  font-size: 14px;
  min-height: 38px;
}

.button-large {
  padding: 14px 20px;
  font-size: 16px;
  min-height: 46px;
}

/* Variants */
.button-primary {
  background: linear-gradient(135deg, #5865f2, #4752c4);
  color: var(--text-primary);
  box-shadow: 0 2px 4px rgba(88, 101, 242, 0.2);
}

.button-primary:hover:not(.button-disabled):not(.button-loading) {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(88, 101, 242, 0.3);
  background: linear-gradient(135deg, #4752c4, #3c4fb8);
}

.button-secondary {
  background: #4f545c;
  color: var(--text-primary);
  border: 1px solid #6d6f78;
}

.button-secondary:hover:not(.button-disabled):not(.button-loading) {
  background: #5d6269;
  border-color: #80848e;
  transform: translateY(-1px);
}

.button-success {
  background: linear-gradient(135deg, #23a55a, #1f8b4c);
  color: var(--text-primary);
  box-shadow: 0 2px 4px rgba(35, 165, 90, 0.2);
}

.button-success:hover:not(.button-disabled):not(.button-loading) {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(35, 165, 90, 0.3);
  background: linear-gradient(135deg, #1f8b4c, #1a7c43);
}

.button-danger {
  background: linear-gradient(135deg, #f23f42, #da373c);
  color: var(--text-primary);
  box-shadow: 0 2px 4px rgba(242, 63, 66, 0.2);
}

.button-danger:hover:not(.button-disabled):not(.button-loading) {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(242, 63, 66, 0.3);
  background: linear-gradient(135deg, #da373c, #c23235);
}

.button-ghost {
  background: transparent;
  color: #b5bac1;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.button-ghost:hover:not(.button-disabled):not(.button-loading) {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.2);
}

.button-link {
  background: transparent;
  color: #5865f2;
  padding: 4px 8px;
  min-height: auto;
}

.button-link:hover:not(.button-disabled):not(.button-loading) {
  color: #4752c4;
  text-decoration: underline;
}

/* States */
.button-disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none !important;
  box-shadow: none !important;
}

.button-loading {
  cursor: wait;
  pointer-events: none;
}

.button-loading .button-content {
  opacity: 0.7;
}

/* Layout modifiers */
.button-full-width {
  width: 100%;
}

.button-rounded {
  border-radius: 20px;
}

.button-icon-only {
  padding: 10px;
  min-width: 38px;
}

.button-icon-only.button-small {
  padding: 6px;
  min-width: 28px;
}

.button-icon-only.button-large {
  padding: 14px;
  min-width: 46px;
}

/* Icons */
.button-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.button-small .button-icon {
  width: 14px;
  height: 14px;
}

.button-large .button-icon {
  width: 18px;
  height: 18px;
}

/* Spinner */
.button-spinner {
  display: flex;
  align-items: center;
  justify-content: center;
}

.spinner {
  width: 16px;
  height: 16px;
  animation: spin 1s linear infinite;
}

.button-small .spinner {
  width: 14px;
  height: 14px;
}

.button-large .spinner {
  width: 18px;
  height: 18px;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Ripple effect */
.modern-button::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0;
  height: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  transform: translate(-50%, -50%);
  transition: width 0.6s, height 0.6s;
}

.modern-button:active::before {
  width: 300px;
  height: 300px;
  transition: width 0s, height 0s;
}

/* Content wrapper */
.button-content {
  position: relative;
  z-index: 1;
}

/* Accessibility improvements */
@media (prefers-reduced-motion: reduce) {
  .modern-button {
    transition: none;
  }
  
  .modern-button:hover {
    transform: none;
  }
  
  .spinner {
    animation: none;
  }
}
</style>