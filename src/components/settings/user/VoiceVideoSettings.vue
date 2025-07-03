<template>
  <div class="voice-video-settings">
    <div class="settings-header">
      <h2 class="settings-title">Voice & Video</h2>
      <p class="settings-description">
        Configure your voice and video settings for optimal communication.
      </p>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Microphone</h3>
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Input Device</h4>
          <p class="setting-description">Select your microphone.</p>
        </div>
        <div class="setting-control">
          <select class="select-input">
            <option>Default</option>
          </select>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Camera</h3>
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Camera</h4>
          <p class="setting-description">Select your camera.</p>
        </div>
        <div class="setting-control">
          <select class="select-input">
            <option>Default</option>
          </select>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  loading: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update-voice-settings': [settings: any]
}>()
</script>

<style scoped>
.voice-video-settings {
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

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 20px 0;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--h-chat-light);
}

.setting-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
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