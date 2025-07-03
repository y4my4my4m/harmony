<template>
  <div class="language-settings">
    <div class="settings-header">
      <h2 class="settings-title">Language</h2>
      <p class="settings-description">
        Choose your preferred language and locale settings.
      </p>
    </div>

    <div class="settings-section">
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Language</h4>
          <p class="setting-description">Select your preferred language.</p>
        </div>
        <div class="setting-control">
          <select 
            v-model="selectedLanguage"
            class="select-input"
            @change="onLanguageChange"
          >
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="zh">中文</option>
          </select>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

interface Props {
  loading: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update-language': [language: string]
}>()

const selectedLanguage = ref('en')

const onLanguageChange = () => {
  emit('update-language', selectedLanguage.value)
}
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
  color: #ffffff;
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: #b9bbbe;
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
  color: #ffffff;
  margin: 0 0 4px 0;
}

.setting-description {
  font-size: 12px;
  color: #b9bbbe;
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
  color: #ffffff;
  font-size: 14px;
  cursor: pointer;
}
</style>