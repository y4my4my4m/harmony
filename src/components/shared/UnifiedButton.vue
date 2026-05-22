<template>
  <component
    :is="tag"
    :type="tag === 'button' ? type : undefined"
    :href="tag === 'a' ? href : undefined"
    :to="tag === 'router-link' ? to : undefined"
    :disabled="disabled || loading"
    :aria-label="ariaLabel"
    :class="buttonClasses"
    @click="handleClick"
    @keydown.enter="handleKeydown"
    @keydown.space="handleKeydown"
  >
    <!-- Loading spinner -->
    <div v-if="loading" class="btn-spinner">
      <div class="spinner"></div>
    </div>
    
    <!-- Icon (left) -->
    <component
      v-if="iconLeft && !loading"
      :is="iconLeft"
      class="btn-icon btn-icon-left"
    />
    
    <!-- Content slot -->
    <span v-if="$slots.default || text" class="btn-content">
      <slot>{{ text }}</slot>
    </span>
    
    <!-- Icon (right) -->
    <component
      v-if="iconRight && !loading"
      :is="iconRight"
      class="btn-icon btn-icon-right"
    />
    
    <!-- Badge/Counter -->
    <span v-if="badge" class="btn-badge">{{ badge }}</span>
  </component>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  // Content
  text?: string
  ariaLabel?: string
  
  // Variants
  variant?: 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'ghost' | 'link'
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  
  // Icons
  iconLeft?: any
  iconRight?: any
  iconOnly?: boolean
  
  // States
  disabled?: boolean
  loading?: boolean
  active?: boolean
  
  // Appearance
  rounded?: boolean
  fullWidth?: boolean
  outline?: boolean
  
  // Functionality
  tag?: 'button' | 'a' | 'router-link'
  type?: 'button' | 'submit' | 'reset'
  href?: string
  to?: string | object
  
  // Additional features
  badge?: string | number
  tooltip?: string
}

interface Emits {
  (e: 'click', event: Event): void
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'secondary',
  size: 'md',
  tag: 'button',
  type: 'button'
})

const emit = defineEmits<Emits>()

const buttonClasses = computed(() => [
  'btn',
  `btn-${props.variant}`,
  `btn-${props.size}`,
  {
    'btn-loading': props.loading,
    'btn-disabled': props.disabled,
    'btn-active': props.active,
    'btn-rounded': props.rounded,
    'btn-full-width': props.fullWidth,
    'btn-outline': props.outline,
    'btn-icon-only': props.iconOnly || (!props.text && !(props as any).$slots?.default && (props.iconLeft || props.iconRight))
  }
])

const handleClick = (event: Event) => {
  if (props.disabled || props.loading) {
    event.preventDefault()
    return
  }
  emit('click', event)
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    handleClick(event)
  }
}
</script>

<style scoped>
/* Base button styles - inherits from design system */
.btn {
  position: relative;
  overflow: hidden;
}

/* Size variants */
.btn-xs {
  padding: var(--space-1) var(--space-2);
  font-size: var(--font-size-xs);
  min-height: 28px;
}

.btn-sm {
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs);
  min-height: 32px;
}

.btn-md {
  padding: var(--space-3) var(--space-4);
  font-size: var(--font-size-sm);
  min-height: 38px;
}

.btn-lg {
  padding: var(--space-4) var(--space-6);
  font-size: var(--font-size-base);
  min-height: 44px;
}

.btn-xl {
  padding: var(--space-5) var(--space-8);
  font-size: var(--font-size-lg);
  min-height: 52px;
}

/* Icon-only button adjustments */
.btn-icon-only.btn-xs {
  padding: var(--space-1);
  min-width: 28px;
}

.btn-icon-only.btn-sm {
  padding: var(--space-2);
  min-width: 32px;
}

.btn-icon-only.btn-md {
  padding: var(--space-3);
  min-width: 38px;
}

.btn-icon-only.btn-lg {
  padding: var(--space-4);
  min-width: 44px;
}

.btn-icon-only.btn-xl {
  padding: var(--space-5);
  min-width: 52px;
}

/* Variant styles */
.btn-primary {
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  color: var(--text-primary);
  border-color: transparent;
}

.btn-primary:hover:not(.btn-disabled):not(.btn-loading) {
  background: var(--harmony-primary-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-medium);
}

.btn-secondary {
  background: var(--background-secondary);
  color: var(--text-primary);
  border-color: var(--border-primary);
}

.btn-secondary:hover:not(.btn-disabled):not(.btn-loading) {
  background: var(--bg-tertiary);
  border-color: var(--border-hover);
}

.btn-success {
  background: linear-gradient(135deg, var(--success), var(--success-hover));
  color: var(--text-primary);
  border-color: transparent;
}

.btn-success:hover:not(.btn-disabled):not(.btn-loading) {
  background: var(--success-hover);
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(35, 165, 90, 0.3);
}

.btn-danger {
  background: linear-gradient(135deg, var(--error), var(--error-hover));
  color: var(--text-primary);
  border-color: transparent;
}

.btn-danger:hover:not(.btn-disabled):not(.btn-loading) {
  background: var(--error-hover);
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(237, 66, 69, 0.3);
}

.btn-warning {
  background: linear-gradient(135deg, var(--warning), #e6cc00);
  color: var(--text-inverse);
  border-color: transparent;
}

.btn-warning:hover:not(.btn-disabled):not(.btn-loading) {
  background: #e6cc00;
  transform: translateY(-1px);
}

.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border-color: var(--border-primary);
}

.btn-ghost:hover:not(.btn-disabled):not(.btn-loading) {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.btn-link {
  background: transparent;
  color: var(--harmony-primary);
  border-color: transparent;
  text-decoration: none;
  padding: var(--space-1) var(--space-2);
  min-height: auto;
}

.btn-link:hover:not(.btn-disabled):not(.btn-loading) {
  color: var(--harmony-primary-hover);
  text-decoration: underline;
}

/* Outline variants */
.btn-outline.btn-primary {
  background: transparent;
  color: var(--harmony-primary);
  border-color: var(--harmony-primary);
}

.btn-outline.btn-primary:hover:not(.btn-disabled):not(.btn-loading) {
  background: var(--harmony-primary);
  color: var(--text-primary);
}

.btn-outline.btn-success {
  background: transparent;
  color: var(--success);
  border-color: var(--success);
}

.btn-outline.btn-success:hover:not(.btn-disabled):not(.btn-loading) {
  background: var(--success);
  color: var(--text-primary);
}

.btn-outline.btn-danger {
  background: transparent;
  color: var(--error);
  border-color: var(--error);
}

.btn-outline.btn-danger:hover:not(.btn-disabled):not(.btn-loading) {
  background: var(--error);
  color: var(--text-primary);
}

/* States */
.btn-loading {
  cursor: wait;
  pointer-events: none;
}

.btn-loading .btn-content {
  opacity: 0.7;
}

.btn-disabled {
  opacity: 0.6;
  cursor: not-allowed;
  pointer-events: none;
}

.btn-active {
  background: var(--bg-active);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1);
}

/* Modifiers */
.btn-rounded {
  border-radius: var(--radius-full);
}

.btn-full-width {
  width: 100%;
  justify-content: center;
}

/* Icon styles */
.btn-icon {
  flex-shrink: 0;
  transition: transform var(--transition-fast);
}

.btn-icon-left {
  margin-right: var(--space-1);
}

.btn-icon-right {
  margin-left: var(--space-1);
}

/* Size-specific icon sizes */
.btn-xs .btn-icon {
  width: 12px;
  height: 12px;
}

.btn-sm .btn-icon {
  width: 14px;
  height: 14px;
}

.btn-md .btn-icon {
  width: 16px;
  height: 16px;
}

.btn-lg .btn-icon {
  width: 18px;
  height: 18px;
}

.btn-xl .btn-icon {
  width: 20px;
  height: 20px;
}

/* Spinner styles */
.btn-spinner {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: var(--space-2);
}

.btn-spinner .spinner {
  width: 16px;
  height: 16px;
}

.btn-xs .btn-spinner .spinner {
  width: 12px;
  height: 12px;
}

.btn-sm .btn-spinner .spinner {
  width: 14px;
  height: 14px;
}

.btn-lg .btn-spinner .spinner {
  width: 18px;
  height: 18px;
}

.btn-xl .btn-spinner .spinner {
  width: 20px;
  height: 20px;
}

/* Badge styles */
.btn-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--error);
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  padding: 2px 6px;
  border-radius: var(--radius-full);
  min-width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

/* Content wrapper */
.btn-content {
  display: flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Focus styles */
.btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

/* Hover effects for better interaction feedback */
.btn:not(.btn-disabled):not(.btn-loading):hover .btn-icon {
  transform: scale(1.1);
}

.btn-link:not(.btn-disabled):not(.btn-loading):hover .btn-icon {
  transform: translateX(2px);
}

/* Active/pressed state */
.btn:not(.btn-disabled):not(.btn-loading):active {
  transform: translateY(1px);
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .btn {
    min-height: 44px; /* Better touch targets */
  }
  
  .btn-xs {
    min-height: 36px;
  }
  
  .btn-sm {
    min-height: 40px;
  }
}

/* Animation for ripple effect on click */
.btn::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 0;
  height: 0;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  transition: width 0.3s ease, height 0.3s ease;
  pointer-events: none;
}

.btn:active:not(.btn-disabled):not(.btn-loading)::after {
  width: 200px;
  height: 200px;
}

/* Accessibility improvements */
@media (prefers-reduced-motion: reduce) {
  .btn,
  .btn-icon,
  .btn::after {
    transition: none !important;
    animation: none !important;
  }
  
  .btn:not(.btn-disabled):not(.btn-loading):hover {
    transform: none !important;
  }
}

/* High contrast mode */
@media (prefers-contrast: high) {
  .btn {
    border-width: 2px;
  }
  
  .btn:focus-visible {
    outline-width: 3px;
  }
}
</style>