<template>
  <div class="search-input" :class="{ 'search-input--focused': isFocused, 'search-input--loading': isLoading }">
    <div class="search-input__icon">
      <svg v-if="!isLoading" viewBox="0 0 24 24" class="search-icon">
        <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
      </svg>
      
      <LoadingSpinner v-else :size="16" />
    </div>
    
    <input 
      ref="inputRef"
      :value="modelValue" 
      @input="handleInput"
      @focus="isFocused = true"
      @blur="isFocused = false"
      @keydown.escape="handleEscape"
      type="text" 
      :placeholder="placeholder"
      class="search-input__field"
      :disabled="disabled"
    />
    
    <button 
      v-if="modelValue && showClearButton" 
      @click="handleClear"
      class="search-input__clear"
      type="button"
      aria-label="Clear search"
    >
      <svg viewBox="0 0 24 24" class="clear-icon">
        <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
      </svg>
    </button>
    
    <div class="search-input__accent"></div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

interface Props {
  modelValue: string
  placeholder?: string
  isLoading?: boolean
  disabled?: boolean
  showClearButton?: boolean
}

interface Emits {
  (e: 'update:modelValue', value: string): void
  (e: 'clear'): void
  (e: 'escape'): void
}

withDefaults(defineProps<Props>(), {
  placeholder: 'Search...',
  isLoading: false,
  disabled: false,
  showClearButton: true
})

const emit = defineEmits<Emits>()

const inputRef = ref<HTMLInputElement>()
const isFocused = ref(false)

const handleInput = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:modelValue', target.value)
}

const handleClear = () => {
  emit('update:modelValue', '')
  emit('clear')
  inputRef.value?.focus()
}

const handleEscape = () => {
  emit('escape')
  inputRef.value?.blur()
}

const focus = () => {
  inputRef.value?.focus()
}

defineExpose({
  focus
})
</script>

<style scoped>
.search-input {
  position: relative;
  display: flex;
  align-items: center;
  background: var(--input-bg);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  overflow: hidden;
}

.search-input:hover {
  border-color: var(--border-hover);
}

.search-input--focused {
  border-color: color-mix(in srgb, var(--harmony-primary) 60%, transparent);
  box-shadow: 0 0 0 2px var(--harmony-primary-alpha-strong);
}

.search-input--loading .search-input__icon {
  color: color-mix(in srgb, var(--harmony-primary) 80%, transparent);
}

.search-input__icon {
  padding: 12px 16px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s ease;
}

.search-icon {
  width: 20px;
  height: 20px;
}

.search-input__field {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  padding: 12px 0;
  font-size: var(--font-size-base);
  color: var(--text-primary);
  line-height: 1.5;
}

.search-input__field::placeholder {
  color: var(--text-muted);
}

.search-input__field:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.search-input__clear {
  padding: 8px 12px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-base);
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 4px;
}

.search-input__clear:hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.clear-icon {
  width: 16px;
  height: 16px;
}

.search-input__accent {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--harmony-primary);
  transform: scaleX(0);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.search-input--focused .search-input__accent {
  transform: scaleX(1);
}

/* Mobile responsive */
@media (max-width: 768px) {
  .search-input__field {
    font-size: 16px; /* Prevent zoom on iOS */
  }
}
</style>
