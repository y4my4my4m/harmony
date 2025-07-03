<template>
  <BaseModal 
    :show="true"
    title="Create Category"
    subtitle="Organize your channels with categories"
    :icon="CategoryIcon"
    compact
    @close="closeCategoryCreator"
  >
    <form @submit.prevent="handleCreation" class="category-form">
      <ModernInput
        v-model="categoryName"
        label="Category Name"
        placeholder="Enter category name..."
        :max-length="100"
        :show-char-count="true"
        :error-message="errorMessage"
        :hint="hint"
        autofocus
        required
        @enter="handleCreation"
      />
    </form>

    <template #footer>
      <div class="modal-actions">
        <ModernButton
          variant="ghost"
          text="Cancel"
          @click="closeCategoryCreator"
        />
        <ModernButton
          variant="success"
          text="Create Category"
          :disabled="!canCreate"
          :loading="isCreating"
          @click="handleCreation"
        />
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import ModernInput from '@/components/common/ModernInput.vue'
import ModernButton from '@/components/common/ModernButton.vue'

// Icon component for the modal header
const CategoryIcon = {
  template: `
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 4C3 3.44772 3.44772 3 4 3H20C20.5523 3 21 3.44772 21 4V6C21 6.55228 20.5523 7 20 7H4C3.44772 7 3 6.55228 3 6V4Z"/>
      <path d="M3 10C3 9.44772 3.44772 9 4 9H20C20.5523 9 21 9.44772 21 10V12C21 12.5523 20.5523 13 20 13H4C3.44772 13 3 12.5523 3 12V10Z"/>
      <path d="M4 15C3.44772 15 3 15.4477 3 16V18C3 18.5523 3.44772 19 4 19H20C20.5523 19 21 18.5523 21 18V16C21 15.4477 20.5523 15 20 15H4Z"/>
    </svg>
  `
}

const emit = defineEmits<{
  showCategoryCreator: [show: boolean]
  createCategory: [name: string]
}>()

const categoryName = ref('')
const errorMessage = ref('')
const isCreating = ref(false)

const canCreate = computed(() => {
  return categoryName.value.trim().length > 0 && categoryName.value.trim().length <= 100
})

const hint = computed(() => {
  if (categoryName.value.length === 0) {
    return 'Categories help organize your channels'
  }
  if (categoryName.value.length > 0 && categoryName.value.length < 2) {
    return 'Category name must be at least 2 characters'
  }
  return 'Good choice! This will help organize your channels'
})

const validateCategoryName = (name: string): string => {
  const trimmed = name.trim()
  
  if (!trimmed) {
    return 'Category name is required'
  }
  
  if (trimmed.length < 2) {
    return 'Category name must be at least 2 characters'
  }
  
  if (trimmed.length > 100) {
    return 'Category name must be 100 characters or less'
  }
  
  // Check for invalid characters
  if (!/^[a-zA-Z0-9\s\-_]+$/.test(trimmed)) {
    return 'Category name can only contain letters, numbers, spaces, hyphens, and underscores'
  }
  
  return ''
}

const closeCategoryCreator = () => {
  emit('showCategoryCreator', false)
}

const handleCreation = async () => {
  const trimmedName = categoryName.value.trim()
  
  // Validate input
  const validationError = validateCategoryName(trimmedName)
  if (validationError) {
    errorMessage.value = validationError
    return
  }
  
  // Clear any previous errors
  errorMessage.value = ''
  isCreating.value = true
  
  try {
    // Simulate API delay for better UX
    await new Promise(resolve => setTimeout(resolve, 500))
    
    emit('createCategory', trimmedName)
    closeCategoryCreator()
  } catch (error) {
    errorMessage.value = 'Failed to create category. Please try again.'
  } finally {
    isCreating.value = false
  }
}

// Clear error when user starts typing
const clearErrorOnInput = () => {
  if (errorMessage.value) {
    errorMessage.value = ''
  }
}

// Watch for changes to clear errors
nextTick(() => {
  const inputElement = document.querySelector('input')
  if (inputElement) {
    inputElement.addEventListener('input', clearErrorOnInput)
  }
})
</script>

<style scoped>
.category-form {
  margin-bottom: 24px;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

/* Responsive design */
@media (max-width: 480px) {
  .modal-actions {
    flex-direction: column-reverse;
    gap: 8px;
  }
  
  .modal-actions .modern-button {
    width: 100%;
  }
}
</style>
