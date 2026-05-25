<template>
  <BaseModal 
    :show="true"
    title="Create Category"
    subtitle="Organize your channels with categories"
    icon="layers"
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
        <UnifiedButton
          variant="ghost"
          text="Cancel"
          @click="closeCategoryCreator"
        />
        <UnifiedButton
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
import { ref, computed, nextTick, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import BaseModal from '@/components/common/BaseModal.vue'
import ModernInput from '@/components/common/ModernInput.vue'
import UnifiedButton from '@/components/shared/UnifiedButton.vue'
import { supabase } from '@/supabase'
import { useServerChannelStore } from '@/stores/useServerChannel'

// Max categories per server
const MAX_CATEGORIES_PER_SERVER = 25

const { t } = useI18n()
const serverChannelStore = useServerChannelStore()

const emit = defineEmits<{
  showCategoryCreator: [show: boolean]
  createCategory: [name: string]
}>()

const categoryName = ref('')
const errorMessage = ref('')
const isCreating = ref(false)
const currentCategoryCount = ref(0)
const isCheckingLimit = ref(false)

// Check category count when component mounts
const checkCategoryCount = async () => {
  const serverId = serverChannelStore.currentServerId
  if (!serverId) return
  
  isCheckingLimit.value = true
  try {
    const { count, error } = await supabase
      .from('channel_categories')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', serverId)
    
    if (error) {
      debug.error('Error checking category count:', error)
      return
    }
    
    currentCategoryCount.value = count || 0
    
    // If already at limit, show error immediately
    if (currentCategoryCount.value >= MAX_CATEGORIES_PER_SERVER) {
      errorMessage.value = t('category.errors.limitReached', { max: MAX_CATEGORIES_PER_SERVER })
    }
  } catch (error) {
    debug.error('Error checking category count:', error)
  } finally {
    isCheckingLimit.value = false
  }
}

// Check limit on mount
onMounted(() => {
  checkCategoryCount()
})

const isAtCategoryLimit = computed(() => currentCategoryCount.value >= MAX_CATEGORIES_PER_SERVER)

const canCreate = computed(() => {
  return categoryName.value.trim().length > 0 && 
         categoryName.value.trim().length <= 100 &&
         !isAtCategoryLimit.value &&
         !isCheckingLimit.value
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
  
  // Check limit again before creating (in case it changed)
  if (isAtCategoryLimit.value) {
    errorMessage.value = t('category.errors.limitReached', { max: MAX_CATEGORIES_PER_SERVER })
    return
  }
  
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
    const serverId = serverChannelStore.currentServerId
    if (!serverId) {
      errorMessage.value = t('category.errors.noServer')
      return
    }
    
    // Double-check count before creating (race condition protection)
    const { count } = await supabase
      .from('channel_categories')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', serverId)
    
    if ((count || 0) >= MAX_CATEGORIES_PER_SERVER) {
      errorMessage.value = t('category.errors.limitReached', { max: MAX_CATEGORIES_PER_SERVER })
      return
    }
    
    emit('createCategory', trimmedName)
    closeCategoryCreator()
  } catch (error) {
    errorMessage.value = t('category.errors.createFailed')
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
