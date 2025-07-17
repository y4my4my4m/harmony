<template>
  <div class="audio-theme-settings">
    <div class="settings-header">
      <h2 class="settings-title">Audio Themes</h2>
      <p class="settings-description">
        Choose your preferred audio experience with different sound themes.
      </p>
    </div>

    <!-- Main Audio Theme Manager -->
    <div class="settings-section">
      <AudioThemeManager 
        :show-test-button="true"
        :show-volume-control="true"
        :show-status="true"
        :show-cache-button="false"
        :show-advanced="false"
        @theme-changed="onThemeChanged"
      />
    </div>

    <!-- Quick Test Section -->
    <div class="settings-section">
      <h3 class="section-title">Sound Preview</h3>
      <p class="section-description">Test how different actions will sound with your current theme</p>
      
      <div class="sound-test-grid">
        <button
          v-for="action in testActions"
          :key="action.id"
          @click="testSound(action.id)"
          :class="['sound-test-btn', action.category]"
          :disabled="!themeStore.isReady"
        >
          <Icon :name="action.icon" />
          <span>{{ action.label }}</span>
        </button>
      </div>
    </div>

    <!-- Advanced Settings -->
    <div class="settings-section advanced-section" v-if="showAdvanced">
      <h3 class="section-title">Advanced Audio Settings</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Audio System Status</h4>
          <p class="setting-description">Current status of the audio theme system</p>
        </div>
        <div class="setting-control">
          <span :class="['status-badge', themeStore.systemStatus]">
            {{ themeStore.systemStatus }}
          </span>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Clear Audio Cache</h4>
          <p class="setting-description">Clear cached audio files to force reload of all sounds</p>
        </div>
        <div class="setting-control">
          <button @click="clearCache" class="clear-cache-btn" :disabled="isLoading">
            <Icon name="trash-2" />
            Clear Cache
          </button>
        </div>
      </div>
      
      <div class="setting-item" v-if="cacheInfo">
        <div class="setting-info">
          <h4 class="setting-label">Cache Information</h4>
          <p class="setting-description">{{ cacheInfo.size }}/{{ cacheInfo.maxSize }} sounds loaded</p>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Reset Audio System</h4>
          <p class="setting-description">Reset all audio settings to defaults</p>
        </div>
        <div class="setting-control">
          <button @click="resetSystem" class="reset-btn danger" :disabled="isLoading">
            <Icon name="rotate-ccw" />
            Reset System
          </button>
        </div>
      </div>
    </div>

    <!-- Toggle Advanced -->
    <div class="advanced-toggle">
      <button @click="showAdvanced = !showAdvanced" class="toggle-btn">
        <Icon :name="showAdvanced ? 'chevron-up' : 'chevron-down'" />
        {{ showAdvanced ? 'Hide' : 'Show' }} Advanced Settings
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useThemeStore } from '@/stores/useTheme'
import { useNotificationStore } from '@/stores/useNotification'
import { AudioThemeService } from '@/services/AudioThemeService'
import AudioThemeManager from '@/components/settings/AudioThemeManager.vue'
import Icon from '@/components/common/Icon.vue'
import type { AudioAction } from '@/types'

// =============================================================================
// STATE
// =============================================================================

const themeStore = useThemeStore()
const notificationStore = useNotificationStore()

// Local state
const isLoading = ref(false)
const showAdvanced = ref(false)

// Test actions for sound preview
const testActions = [
  { id: 'mention', label: 'Mention', icon: 'at-sign', category: 'notification' },
  { id: 'dm', label: 'Message', icon: 'message-circle', category: 'notification' },
  { id: 'reaction', label: 'Reaction', icon: 'heart', category: 'notification' },
  { id: 'voice_connect', label: 'Voice Join', icon: 'phone', category: 'voice' },
  { id: 'voice_disconnect', label: 'Voice Leave', icon: 'phone-off', category: 'voice' },
  { id: 'ui_success', label: 'Success', icon: 'check-circle', category: 'ui' },
  { id: 'ui_error', label: 'Error', icon: 'alert-circle', category: 'ui' },
  { id: 'ui_click', label: 'Click', icon: 'mouse-pointer', category: 'ui' }
] as const

// =============================================================================
// COMPUTED
// =============================================================================

const cacheInfo = computed(() => {
  return themeStore.getCacheInfo()
})

// =============================================================================
// METHODS
// =============================================================================

const testSound = async (actionId: string): Promise<void> => {
  try {
    await themeStore.testAudio(actionId as AudioAction)
    notificationStore.showToast(
      'ui_success' as any,
      'Sound Test',
      `Tested ${actionId} successfully`,
      2000
    )
  } catch (error) {
    console.error('Failed to test sound:', error)
    notificationStore.showToast(
      'ui_error' as any,
      'Sound Test Failed',
      `Failed to test ${actionId}`,
      3000
    )
  }
}

const clearCache = async (): Promise<void> => {
  try {
    isLoading.value = true
    await themeStore.clearAudioCache()
    notificationStore.showToast(
      'ui_success' as any,
      'Cache Cleared',
      'Audio cache cleared successfully',
      2000
    )
  } catch (error) {
    console.error('Failed to clear cache:', error)
    notificationStore.showToast(
      'ui_error' as any,
      'Cache Clear Failed',
      'Failed to clear audio cache',
      3000
    )
  } finally {
    isLoading.value = false
  }
}

const resetSystem = async (): Promise<void> => {
  try {
    isLoading.value = true
    await themeStore.resetAudioSystem()
    notificationStore.showToast(
      'ui_success' as any,
      'System Reset',
      'Audio system reset successfully',
      2000
    )
  } catch (error) {
    console.error('Failed to reset system:', error)
    notificationStore.showToast(
      'ui_error' as any,
      'Reset Failed',
      'Failed to reset audio system',
      3000
    )
  } finally {
    isLoading.value = false
  }
}

const onThemeChanged = (themeId: string): void => {
  notificationStore.showToast(
    'ui_success' as any,
    'Theme Changed',
    `Switched to ${themeId} theme`,
    2000
  )
}


// =============================================================================
// LIFECYCLE
// =============================================================================

onMounted(async () => {
  try {
    await themeStore.initialize()
  } catch (error) {
    console.error('Failed to initialize audio theme store:', error)
    notificationStore.showToast(
      'ui_error' as any,
      'Initialization Failed',
      'Failed to initialize audio system',
      3000
    )
  }
})
</script>

<style scoped>
.audio-theme-settings {
  max-width: 740px;
  margin: 0 auto;
  padding: 0 16px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 20px;
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
  background: var(--h-chat-darker);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 20px 0;
}

/* Current Theme */
.current-theme-section {
  margin-bottom: 20px;
}

.current-theme-card {
  background: linear-gradient(135deg, var(--h-brand), #677bc4);
  border-radius: 12px;
  padding: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #ffffff;
}

.theme-preview {
  display: flex;
  align-items: center;
  gap: 16px;
}

.theme-icon {
  font-size: 32px;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 50%;
}

.theme-info h3 {
  margin: 0 0 4px 0;
  font-size: 18px;
  font-weight: 600;
}

.theme-info p {
  margin: 0 0 4px 0;
  font-size: 14px;
  opacity: 0.9;
}

.theme-author {
  font-size: 12px;
  opacity: 0.7;
}

.test-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  padding: 8px 16px;
  color: #ffffff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 6px;
}

.test-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.2);
}

.test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Volume Control */
.volume-control {
  display: flex;
  align-items: center;
  gap: 16px;
}

.volume-slider-container {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
}

.volume-icon {
  color: #b9bbbe;
  width: 18px;
  height: 18px;
}

.volume-slider {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--h-chat-light);
  outline: none;
  cursor: pointer;
}

.volume-slider::-webkit-slider-thumb {
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--h-brand);
  cursor: pointer;
  border: 2px solid #ffffff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.volume-slider::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--h-brand);
  cursor: pointer;
  border: 2px solid #ffffff;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.volume-display {
  min-width: 40px;
  text-align: center;
  font-size: 14px;
  font-weight: 500;
  color: #ffffff;
}

/* Theme Grid */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.theme-card {
  background: var(--h-chat);
  border: 2px solid var(--h-chat-light);
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}

.theme-card:hover {
  border-color: var(--h-brand);
  transform: translateY(-2px);
}

.theme-card.active {
  border-color: var(--h-brand);
  background: rgba(88, 101, 242, 0.05);
}

.theme-card.loading {
  opacity: 0.7;
  pointer-events: none;
}

.theme-card-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}

.theme-icon-small {
  font-size: 20px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--h-chat-light);
  border-radius: 6px;
}

.theme-title {
  flex: 1;
}

.theme-title h4 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
}

.theme-version {
  font-size: 12px;
  color: #b9bbbe;
}

.theme-status {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.active-icon {
  color: var(--h-brand);
  width: 18px;
  height: 18px;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--h-chat-light);
  border-top: 2px solid var(--h-brand);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.theme-description-small {
  font-size: 13px;
  color: #b9bbbe;
  margin: 0 0 12px 0;
  line-height: 1.4;
}

.theme-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.theme-author-small {
  font-size: 12px;
  color: #72767d;
}

.test-theme-btn {
  background: transparent;
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  padding: 6px;
  color: #b9bbbe;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.test-theme-btn:hover:not(:disabled) {
  border-color: var(--h-brand);
  color: var(--h-brand);
}

.test-theme-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Sound Test Grid */
.sound-test-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
}

.sound-test-btn {
  background: transparent;
  border: 1px solid var(--h-chat-light);
  border-radius: 6px;
  padding: 12px 8px;
  color: #b9bbbe;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.sound-test-btn:hover:not(:disabled) {
  border-color: var(--h-brand);
  color: #ffffff;
  background: rgba(88, 101, 242, 0.1);
}

.sound-test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Advanced Settings */
.advanced-section {
  border: 1px dashed var(--h-chat-light);
  background: rgba(79, 84, 92, 0.3);
}

.setting-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--h-chat-light);
}

.setting-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.setting-info {
  flex: 1;
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

.clear-cache-btn {
  background: transparent;
  border: 1px solid #f04747;
  border-radius: 4px;
  padding: 8px 12px;
  color: #f04747;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.clear-cache-btn:hover {
  background: rgba(240, 71, 71, 0.1);
}

.advanced-toggle {
  text-align: center;
  margin-top: 16px;
}

.toggle-btn {
  background: transparent;
  border: 1px solid var(--h-chat-light);
  border-radius: 6px;
  padding: 8px 16px;
  color: #b9bbbe;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.toggle-btn:hover {
  border-color: var(--h-brand);
  color: #ffffff;
}

/* Responsive */
@media (max-width: 768px) {
  .current-theme-card {
    flex-direction: column;
    gap: 16px;
    text-align: center;
  }
  
  .theme-grid {
    grid-template-columns: 1fr;
  }
  
  .sound-test-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .volume-control {
    flex-direction: column;
    gap: 12px;
  }
  
  .setting-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
}
</style>
