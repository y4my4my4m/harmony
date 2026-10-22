<template>
  <BaseModal 
    :show="true"
    :title="t('category.create')"
    :subtitle="t('chatNav.create.categorySubtitle')"
    icon="layers"
    compact
    @close="closeCategoryCreator"
  >
    <form @submit.prevent="handleCreation" class="category-form">
      <ModernInput
        :model-value="categoryName"
        :label="t('chatNav.create.categoryName')"
        :placeholder="t('chatNav.create.categoryPlaceholder')"
        :max-length="100"
        :show-char-count="true"
        :error-message="errorMessage"
        :hint="hint"
        autofocus
        required
        @update:model-value="categoryName = formatCategoryNameInput($event)"
        @enter="handleCreation"
      />
      <CategoryPrivacyFields
        v-if="serverChannelStore.currentServerId"
        v-model="privacy"
        class="category-privacy-fields"
        :server-id="serverChannelStore.currentServerId"
      />
    </form>

    <template #footer>
      <div class="modal-actions">
        <UnifiedButton
          variant="ghost"
          :text="t('common.cancel')"
          @click="closeCategoryCreator"
        />
        <UnifiedButton
          variant="success"
          :text="t('category.create')"
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
import CategoryPrivacyFields from '@/components/CategoryPrivacyFields.vue'
import { supabase } from '@/supabase'
import { useServerChannelStore } from '@/stores/useServerChannel'
import type { CategoryPrivacy } from '@/services/categoryPermissions'
import { categoryNameProblem, formatCategoryNameInput, finalizeCategoryName } from '@/utils/channelName'

// Max categories per server
const MAX_CATEGORIES_PER_SERVER = 25

const { t } = useI18n()
const serverChannelStore = useServerChannelStore()

const emit = defineEmits<{
  showCategoryCreator: [show: boolean]
  createCategory: [name: string, privacy: CategoryPrivacy]
}>()

const categoryName = ref('')
const privacy = ref<CategoryPrivacy>({ isPrivate: false, roleIds: [], userIds: [] })
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
  const name = finalizeCategoryName(categoryName.value)
  return name.length > 0 &&
         name.length <= 100 &&
         !isAtCategoryLimit.value &&
         !isCheckingLimit.value
})

const hint = computed(() => {
  if (categoryName.value.length === 0) {
    return t('chatNav.create.categoryHint')
  }
  if (categoryName.value.length > 0 && categoryName.value.length < 2) {
    return t('chatNav.create.categoryTooShort')
  }
  return t('chatNav.create.categoryGood')
})

const validateCategoryName = (name: string): string => {
  const trimmed = name.trim()
  
  switch (categoryNameProblem(trimmed)) {
    case 'required': return t('chatNav.create.categoryRequired')
    case 'tooShort': return t('chatNav.create.categoryTooShort')
    case 'tooLong': return t('chatNav.create.categoryTooLong')
    default: return ''
  }
}

const closeCategoryCreator = () => {
  emit('showCategoryCreator', false)
}

const handleCreation = async () => {
  const trimmedName = finalizeCategoryName(categoryName.value)
  
  // Check limit again before creating (in case it changed)
  if (isAtCategoryLimit.value) {
    errorMessage.value = t('category.errors.limitReached', { max: MAX_CATEGORIES_PER_SERVER })
    return
  }
  
  const validationError = validateCategoryName(trimmedName)
  if (validationError) {
    errorMessage.value = validationError
    return
  }
  
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
    
    emit('createCategory', trimmedName, privacy.value)
    closeCategoryCreator()
  } catch (error) {
    errorMessage.value = t('category.errors.createFailed')
  } finally {
    isCreating.value = false
  }
}

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

.category-privacy-fields {
  margin-top: 16px;
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
