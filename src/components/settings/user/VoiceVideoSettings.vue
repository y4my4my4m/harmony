<template>
  <div class="voice-video-settings-page">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.voice.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.voice.description') }}
      </p>
    </div>
    
    <VoiceSettingsInline 
      :loading="loading"
      @update-voice-settings="handleSettingsUpdate"
    />
  </div>
</template>

<script setup lang="ts">
import VoiceSettingsInline from './VoiceSettingsInline.vue';

interface Props {
  loading: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  'update-voice-settings': [settings: any]
}>()

const handleSettingsUpdate = (settings: any) => {
  emit('update-voice-settings', settings);
}
</script>

<style scoped>
.voice-video-settings-page {
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
</style>