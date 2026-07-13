<template>
  <div class="input-group" :class="{ 'input-group-error': hasError, 'input-group-disabled': disabled }">
    <!-- Label -->
    <label v-if="label" :for="inputId" class="input-label">
      {{ label }}
      <span v-if="required" class="input-required">*</span>
    </label>
    
    <!-- Input wrapper -->
    <div class="input-wrapper">
      <!-- Prefix icon/content -->
      <div v-if="$slots.prefix || prefixIcon" class="input-prefix">
        <slot name="prefix">
          <component v-if="prefixIcon" :is="prefixIcon" class="input-icon" />
        </slot>
      </div>
      
      <!-- Main input element -->
      <component
        :is="inputComponent"
        :id="inputId"
        ref="inputRef"
        :value="modelValue"
        :type="computedType"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        :required="required"
        :autocomplete="autocomplete"
        :maxlength="maxLength"
        :minlength="minLength"
        :min="min"
        :max="max"
        :step="step"
        :rows="rows"
        :cols="cols"
        :class="inputClasses"
        :aria-describedby="hasError ? `${inputId}-error` : hasHint ? `${inputId}-hint` : undefined"
        :aria-invalid="hasError"
        @input="handleInput"
        @change="handleChange"
        @blur="handleBlur"
        @focus="handleFocus"
        @keydown="handleKeydown"
        @keypress="handleKeypress"
        @keyup="handleKeyup"
      />
      
      <!-- Suffix icon/content -->
      <div v-if="$slots.suffix || suffixIcon || showPasswordToggle || showClearButton" class="input-suffix">
        <!-- Clear button -->
        <button
          v-if="showClearButton && modelValue"
          type="button"
          class="input-action-btn"
          @click="clearInput"
          :aria-label="clearButtonLabel"
        >
          <svg class="input-icon" viewBox="0 0 24 24">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" fill="currentColor"/>
          </svg>
        </button>
        
        <!-- Password toggle -->
        <button
          v-if="showPasswordToggle"
          type="button"
          class="input-action-btn"
          @click="togglePasswordVisibility"
          :aria-label="passwordVisible ? 'Hide password' : 'Show password'"
        >
          <svg v-if="passwordVisible" class="input-icon" viewBox="0 0 24 24">
            <path d="M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z" fill="currentColor"/>
          </svg>
          <svg v-else class="input-icon" viewBox="0 0 24 24">
            <path d="M11.83,9L15,12.16C15,12.11 15,12.05 15,12A3,3 0 0,0 12,9C11.94,9 11.89,9 11.83,9M7.53,9.8L9.08,11.35C9.03,11.56 9,11.77 9,12A3,3 0 0,0 12,15C12.22,15 12.44,14.97 12.65,14.92L14.2,16.47C13.53,16.8 12.79,17 12,17A5,5 0 0,1 7,12C7,11.21 7.2,10.47 7.53,9.8M2,4.27L4.28,6.55L4.73,7C3.08,8.3 1.78,10 1,12C2.73,16.39 7,19.5 12,19.5C13.55,19.5 15.03,19.2 16.38,18.66L16.81,19.09L19.73,22L21,20.73L3.27,3M12,7A5,5 0 0,1 17,12C17,12.64 16.87,13.26 16.64,13.82L19.57,16.75C21.07,15.5 22.27,13.86 23,12C21.27,7.61 17,4.5 12,4.5C10.6,4.5 9.26,4.75 8,5.2L10.17,7.35C10.76,7.13 11.37,7 12,7Z" fill="currentColor"/>
          </svg>
        </button>
        
        <!-- Custom suffix -->
        <slot name="suffix">
          <component v-if="suffixIcon" :is="suffixIcon" class="input-icon" />
        </slot>
      </div>
    </div>
    
    <!-- Character count -->
    <div v-if="showCharCount && maxLength" class="input-char-count">
      {{ (typeof modelValue === 'string' ? modelValue.length : String(modelValue ?? '').length) }} / {{ maxLength }}
    </div>
    
    <!-- Error message -->
    <div v-if="hasError" :id="`${inputId}-error`" class="input-error">
      {{ errorMessage }}
    </div>
    
    <!-- Hint text -->
    <div v-if="hasHint && !hasError" :id="`${inputId}-hint`" class="input-hint">
      {{ hint }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

interface Props {
  modelValue: string | number | null | undefined
  type?: string
  placeholder?: string
  label?: string
  hint?: string
  errorMessage?: string

  disabled?: boolean
  readonly?: boolean
  required?: boolean
  autocomplete?: string

  maxLength?: number
  minLength?: number
  min?: number | string
  max?: number | string
  step?: number | string

  rows?: number
  cols?: number
  resize?: boolean

  size?: 'sm' | 'md' | 'lg'
  variant?: 'default' | 'filled' | 'outlined'

  prefixIcon?: any
  suffixIcon?: any
  clearable?: boolean
  clearButtonLabel?: string

  showCharCount?: boolean
  passwordToggle?: boolean

  id?: string
}

interface Emits {
  (e: 'update:modelValue', value: string | number): void
  (e: 'input', event: Event): void
  (e: 'change', event: Event): void
  (e: 'blur', event: FocusEvent): void
  (e: 'focus', event: FocusEvent): void
  (e: 'keydown', event: KeyboardEvent): void
  (e: 'keypress', event: KeyboardEvent): void
  (e: 'keyup', event: KeyboardEvent): void
  (e: 'clear'): void
}

const props = withDefaults(defineProps<Props>(), {
  type: 'text',
  size: 'md',
  variant: 'default',
  clearButtonLabel: 'Clear input'
})

const emit = defineEmits<Emits>()

const inputRef = ref<HTMLInputElement | HTMLTextAreaElement>()
const passwordVisible = ref(false)
const isFocused = ref(false)

const inputId = computed(() => props.id || `input-${Math.random().toString(36).substr(2, 9)}`)

const inputComponent = computed(() => {
  return props.type === 'textarea' ? 'textarea' : 'input'
})

const computedType = computed(() => {
  if (props.type === 'password' && passwordVisible.value) {
    return 'text'
  }
  return props.type === 'textarea' ? undefined : props.type
})

const showPasswordToggle = computed(() => {
  return props.passwordToggle && props.type === 'password'
})

const showClearButton = computed(() => {
  return props.clearable && !props.disabled && !props.readonly
})

const hasError = computed(() => Boolean(props.errorMessage))
const hasHint = computed(() => Boolean(props.hint))

const inputClasses = computed(() => [
  'form-input',
  `input-${props.size}`,
  `input-${props.variant}`,
  {
    'input-focused': isFocused.value,
    'input-error': hasError.value,
    // Reading $slots from `props` is non-standard; defineProps in <script setup>
    // doesn't carry $slots. Reading via useSlots() / `getCurrentInstance()` would
    // be cleaner; for now, cast to bypass.
    'input-with-prefix': props.prefixIcon || (props as any).$slots?.prefix,
    'input-with-suffix': props.suffixIcon || (props as any).$slots?.suffix || showPasswordToggle.value || showClearButton.value,
    'input-no-resize': props.type === 'textarea' && !props.resize
  }
])

const handleInput = (event: Event) => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement
  emit('update:modelValue', target.value)
  emit('input', event)
}

const handleChange = (event: Event) => {
  emit('change', event)
}

const handleBlur = (event: FocusEvent) => {
  isFocused.value = false
  emit('blur', event)
}

const handleFocus = (event: FocusEvent) => {
  isFocused.value = true
  emit('focus', event)
}

const handleKeydown = (event: KeyboardEvent) => {
  emit('keydown', event)
}

const handleKeypress = (event: KeyboardEvent) => {
  emit('keypress', event)
}

const handleKeyup = (event: KeyboardEvent) => {
  emit('keyup', event)
}

const togglePasswordVisibility = () => {
  passwordVisible.value = !passwordVisible.value
}

const clearInput = () => {
  emit('update:modelValue', '')
  emit('clear')
  inputRef.value?.focus()
}

const focus = () => {
  inputRef.value?.focus()
}

const blur = () => {
  inputRef.value?.blur()
}

const select = () => {
  if (inputRef.value && 'select' in inputRef.value) {
    inputRef.value.select()
  }
}

defineExpose({
  focus,
  blur,
  select,
  inputRef
})
</script>

<style scoped>
/* Input group container */
.input-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.input-group-disabled {
  opacity: 0.6;
}

.input-group-error .input-wrapper {
  border-color: var(--error);
}

/* Label */
.input-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0;
}

.input-required {
  color: var(--error);
  margin-left: var(--space-1);
}

/* Input wrapper */
.input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  transition: all var(--transition-base);
  overflow: hidden;
}

.input-wrapper:focus-within {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--harmony-primary-light);
}

.input-wrapper:hover:not(:focus-within) {
  border-color: var(--border-hover);
}

/* Input variants */
.input-wrapper.input-filled {
  background: var(--bg-tertiary);
  border-color: transparent;
}

.input-wrapper.input-outlined {
  background: transparent;
  border-width: 2px;
}

/* Input element */
.form-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-family: inherit;
  transition: all var(--transition-base);
  min-width: 0;
}

.form-input::placeholder {
  color: var(--text-tertiary);
}

.form-input:disabled {
  cursor: not-allowed;
}

/* Input sizes */
.input-sm {
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  min-height: 32px;
}

.input-md {
  padding: var(--space-3) var(--space-4);
  font-size: var(--font-size-base);
  min-height: 38px;
}

.input-lg {
  padding: var(--space-4) var(--space-5);
  font-size: var(--font-size-lg);
  min-height: 44px;
}

/* Prefix/suffix adjustments */
.input-with-prefix.input-sm {
  padding-left: var(--space-2);
}

.input-with-prefix.input-md {
  padding-left: var(--space-2);
}

.input-with-prefix.input-lg {
  padding-left: var(--space-2);
}

.input-with-suffix.input-sm {
  padding-right: var(--space-2);
}

.input-with-suffix.input-md {
  padding-right: var(--space-2);
}

.input-with-suffix.input-lg {
  padding-right: var(--space-2);
}

/* Prefix and suffix */
.input-prefix,
.input-suffix {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-3);
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.input-prefix {
  border-right: 1px solid var(--border-secondary);
}

.input-suffix {
  border-left: 1px solid var(--border-secondary);
}

/* Icons */
.input-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.input-sm .input-icon {
  width: 14px;
  height: 14px;
}

.input-lg .input-icon {
  width: 18px;
  height: 18px;
}

/* Action buttons */
.input-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
  transition: all var(--transition-base);
}

.input-action-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.input-action-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}

/* Character count */
.input-char-count {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  text-align: right;
  margin-top: -var(--space-1);
}

/* Error message */
.input-error {
  font-size: var(--font-size-xs);
  color: var(--error);
  margin-top: -var(--space-1);
}

/* Hint text */
.input-hint {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  margin-top: -var(--space-1);
}

/* Textarea specific */
textarea.form-input {
  resize: vertical;
  min-height: 80px;
  font-family: inherit;
  line-height: var(--line-height-normal);
}

.input-no-resize textarea.form-input {
  resize: none;
}

/* Focus states */
.input-focused {
  /* Focus styles handled by wrapper */
}

/* Error state */
.input-error .input-wrapper {
  border-color: var(--error);
}

.input-error .input-wrapper:focus-within {
  box-shadow: 0 0 0 3px rgba(237, 66, 69, 0.2);
}

/* Disabled state */
.input-group-disabled .input-wrapper {
  background: var(--bg-quaternary);
  cursor: not-allowed;
}

.input-group-disabled .form-input {
  color: var(--text-muted);
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .input-md,
  .input-lg {
    min-height: 44px; /* Better touch targets */
  }
}

/* High contrast support */
@media (prefers-contrast: high) {
  .input-wrapper {
    border-width: 2px;
  }
  
  .input-wrapper:focus-within {
    outline: 2px solid var(--harmony-primary);
    outline-offset: 2px;
  }
}

/* Reduced motion support */
@media (prefers-reduced-motion: reduce) {
  .input-wrapper,
  .form-input,
  .input-action-btn {
    transition: none;
  }
}
</style>