<template>
  <div class="notification-settings">
    <div class="settings-header">
      <h2 class="settings-title">Notifications</h2>
      <p class="settings-description">
        Control when and how you receive notifications.
      </p>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Desktop Notifications</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable Desktop Notifications</h4>
          <p class="setting-description">Get notified when you receive messages.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.enableDesktopNotifications"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Enable Unread Message Badge</h4>
          <p class="setting-description">Show unread message count in the taskbar.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.enableUnreadBadge"
            @change="onSettingChange"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Sounds</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Message Sounds</h4>
          <p class="setting-description">Play sounds when receiving messages.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.enableMessageSounds"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">PTT Activation Sound</h4>
          <p class="setting-description">Play sound when push-to-talk is activated.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.enablePTTSound"
            @change="onSettingChange"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'

interface Props {
  loading: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update-notifications': [settings: any]
}>()

const settings = ref({
  enableDesktopNotifications: true,
  enableUnreadBadge: true,
  enableMessageSounds: true,
  enablePTTSound: false,
})

const originalSettings = ref({ ...settings.value })

const hasChanges = computed(() => {
  return JSON.stringify(settings.value) !== JSON.stringify(originalSettings.value)
})

const onSettingChange = () => {
  // Settings changed
}
</script>

<style scoped>
.notification-settings {
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
</style>