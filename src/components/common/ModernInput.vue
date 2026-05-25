<template>
  <div class="input-group" :class="{ 'has-error': hasError, 'is-focused': isFocused }">
    <label v-if="label" class="input-label" :for="inputId">
      {{ label }}
      <span v-if="required" class="required-indicator">*</span>
    </label>
    
    <div class="input-wrapper">
      <input
        :id="inputId"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :required="required"
        :disabled="disabled"
        :maxlength="maxLength"
        class="modern-input"
        @input="handleInput"
        @focus="handleFocus"
        @blur="handleBlur"
        @keydown="handleKeydown"
        ref="inputRef"
      />
      <div class="input-accent"></div>
      
      <!-- Character count for text inputs -->
      <div v-if="showCharCount && maxLength" class="char-count">
        {{ currentLength }} / {{ maxLength }}
      </div>
    </div>
    
    <!-- Error message -->
    <div v-if="hasError" class="error-message">
      <svg class="error-icon" viewBox="0 0 20 20">
        <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" fill="currentColor"/>
      </svg>
      {{ errorMessage }}
    </div>
    
    <!-- Success message -->
    <div v-if="successMessage && !hasError" class="success-message">
      <svg class="success-icon" viewBox="0 0 20 20">
        <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" fill="currentColor"/>
      </svg>
      {{ successMessage }}
    </div>
    
    <!-- Hint text -->
    <div v-if="hint && !hasError && !successMessage" class="hint-text">
      {{ hint }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'

interface Props {
  modelValue: string
  label?: string
  placeholder?: string
  type?: string
  required?: boolean
  disabled?: boolean
  maxLength?: number
  showCharCount?: boolean
  errorMessage?: string
  successMessage?: string
  hint?: string
  autofocus?: boolean
  validateOnInput?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  type: 'text',
  required: false,
  disabled: false,
  showCharCount: false,
  autofocus: false,
  validateOnInput: true
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'focus': [event: FocusEvent]
  'blur': [event: FocusEvent]
  'keydown': [event: KeyboardEvent]
  'enter': [event: KeyboardEvent]
}>()

const inputRef = ref<HTMLInputElement>()
const isFocused = ref(false)
const inputId = `input-${Math.random().toString(36).substr(2, 9)}`

const currentLength = computed(() => props.modelValue?.length || 0)
const hasError = computed(() => !!props.errorMessage)

const handleInput = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:modelValue', target.value)
}

const handleFocus = (event: FocusEvent) => {
  isFocused.value = true
  emit('focus', event)
}

const handleBlur = (event: FocusEvent) => {
  isFocused.value = false
  emit('blur', event)
}

const handleKeydown = (event: KeyboardEvent) => {
  emit('keydown', event)
  
  if (event.key === 'Enter') {
    emit('enter', event)
  }
}

const focus = () => {
  nextTick(() => {
    inputRef.value?.focus()
  })
}

// Auto-focus if specified
if (props.autofocus) {
  nextTick(() => {
    focus()
  })
}

defineExpose({
  focus,
  blur: () => inputRef.value?.blur()
})
</script>

<style scoped>
.input-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.input-label {
  font-size: 12px;
  font-weight: 700;
  color: #b5bac1;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

.required-indicator {
  color: #f23f42;
  font-weight: 600;
}

.input-wrapper {
  position: relative;
  display: flex;
  flex-direction: column;
}

.modern-input {
  background-color: #1e1f22;
  border: 2px solid #383a40;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 400;
  padding: 10px 12px;
  transition: all 0.15s ease;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}

.modern-input:focus {
  border-color: #0EA5E9;
  box-shadow: 0 0 0 1px #0EA5E9;
}

.modern-input:hover:not(:focus):not(:disabled) {
  border-color: #4f545c;
}

.modern-input:disabled {
  background-color:  var(--background-quinary);
  border-color: #3c3f44;
  color: #6d6f78;
  cursor: not-allowed;
}

.modern-input::placeholder {
  color: #6d6f78;
}

/* Error state */
.input-group.has-error .modern-input {
  border-color: #f23f42;
}

.input-group.has-error .modern-input:focus {
  border-color: #f23f42;
  box-shadow: 0 0 0 1px #f23f42;
}

/* Success state */
.input-group:not(.has-error) .modern-input:valid:not(:placeholder-shown) {
  border-color: #23a55a;
}

.input-accent {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  background: linear-gradient(90deg, #0EA5E9, #38BDF8);
  border-radius: 1px;
  width: 0;
  transition: width 0.3s ease;
}

.input-group.is-focused .input-accent {
  width: 100%;
}

.input-group.has-error .input-accent {
  background: linear-gradient(90deg, #f23f42, #da373c);
}

.char-count {
  align-self: flex-end;
  font-size: 12px;
  color: #6d6f78;
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}

.error-message {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #f23f42;
  margin-top: -4px;
}

.error-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.success-message {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #23a55a;
  margin-top: -4px;
}

.success-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.hint-text {
  font-size: 12px;
  color: #6d6f78;
  margin-top: -4px;
  line-height: 1.3;
}

/* Focus ring for accessibility */
.modern-input:focus-visible {
  outline: 2px solid #0EA5E9;
  outline-offset: 2px;
}

/* Animation for error/success states */
.error-message,
.success-message {
  animation: slideInUp 0.2s ease-out;
}

@keyframes slideInUp {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>