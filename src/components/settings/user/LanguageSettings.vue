<template>
  <div class="language-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.language.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.language.description') }}
      </p>
    </div>

    <div class="settings-section">
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('settings.language.selectLanguage') }}</h4>
          <p class="setting-description">{{ $t('settings.language.selectLanguageDesc') }}</p>
        </div>
        <div class="setting-control">
          <select 
            v-model="selectedLanguage"
            class="select-input"
            @change="onLanguageChange"
          >
            <option v-for="lang in availableLanguages" :key="lang.code" :value="lang.code">
              {{ lang.name }}
            </option>
          </select>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n'
import { setLocale, availableLocales } from '@/i18n'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'

interface Props {
  loading: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update-language': [language: string]
}>()

const { locale } = useI18n()
const authStore = useAuthStore()

const selectedLanguage = ref(locale.value)
const availableLanguages = availableLocales

const onLanguageChange = async () => {
  // Update i18n locale
  await setLocale(selectedLanguage.value)
  
  // Emit to parent
  emit('update-language', selectedLanguage.value)
  
  // Save to Supabase
  const userId = authStore.session?.user?.id
  if (userId) {
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          locale: selectedLanguage.value,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)
      
      if (error) throw error
      debug.log('✅ Language preference saved')
    } catch (error) {
      debug.error('Failed to save language preference:', error)
    }
  }
}

onMounted(async () => {
  // Load saved language from Supabase
  const userId = authStore.session?.user?.id
  if (userId) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('locale')
        .eq('id', userId)
        .single()
      
      if (error) throw error
      
      if (data?.locale) {
        selectedLanguage.value = data.locale
        await setLocale(data.locale)
      }
    } catch (error) {
      debug.error('Failed to load language preference:', error)
    }
  }
})
</script>

<style scoped>
.language-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--h-chat);
  border-radius: 8px;
  border: 1px solid var(--h-chat-light);
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.setting-info {
  flex: 1;
  margin-right: 16px;
}

.setting-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.setting-description {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.setting-control {
  flex-shrink: 0;
}

.select-input {
  padding: 8px 12px;
  background-color: var(--h-chat-darker);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
}
</style>