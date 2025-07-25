<template>
  <div class="voice-video-settings-page">
    <div class="settings-header">
      <h2 class="settings-title">Voice & Video</h2>
      <p class="settings-description">
        Configure your voice and video settings for optimal communication.
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
  color: #ffffff;
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}
</style>