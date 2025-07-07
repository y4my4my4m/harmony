<template>
  <div class="audio-theme-settings">
    <div class="settings-header">
      <h2 class="settings-title">Audio Themes</h2>
      <p class="settings-description">
        Choose your preferred audio experience with different sound themes.
      </p>
    </div>

    <!-- Current Theme Display -->
    <div class="current-theme-section">
      <div class="current-theme-card" v-if="currentTheme">
        <div class="theme-preview">
          <div class="theme-icon">
            🎵
          </div>
          <div class="theme-info">
            <h3 class="theme-name">{{ currentTheme.name }}</h3>
            <p class="theme-description">{{ currentTheme.description }}</p>
            <span class="theme-author">by {{ currentTheme.author }}</span>
          </div>
        </div>
        <div class="theme-actions">
          <button 
            @click="testCurrentTheme" 
            class="test-btn"
            :disabled="isLoading"
          >
            <Icon name="volume-2" />
            Test Sound
          </button>
        </div>
      </div>
    </div>

    <!-- Volume Control -->
    <div class="settings-section">
      <h3 class="section-title">Volume</h3>
      
      <div class="volume-control">
        <div class="volume-slider-container">
          <Icon name="volume-1" class="volume-icon" />
          <input
            v-model.number="localVolume"
            @input="onVolumeChange"
            type="range"
            min="0"
            max="100"
            step="1"
            class="volume-slider"
          />
          <Icon name="volume-2" class="volume-icon" />
        </div>
        <div class="volume-display">
          {{ Math.round(localVolume) }}%
        </div>
      </div>
    </div>

    <!-- Theme Selection -->
    <div class="settings-section">
      <h3 class="section-title">Available Themes</h3>
      
      <div class="theme-grid">
        <div
          v-for="theme in availableThemes"
          :key="theme.id"
          :class="[
            'theme-card',
            { 
              'active': theme.id === currentThemeId,
              'loading': isLoading && pendingThemeId === theme.id
            }
          ]"
          @click="selectTheme(theme.id)"
        >
          <div class="theme-card-header">
            <div class="theme-icon-small">
              {{ getThemeIcon(theme.id) }}
            </div>
            <div class="theme-title">
              <h4>{{ theme.name }}</h4>
              <span class="theme-version">v{{ theme.version }}</span>
            </div>
            <div class="theme-status">
              <Icon 
                v-if="theme.id === currentThemeId" 
                name="check-circle" 
                class="active-icon"
              />
              <div 
                v-else-if="isLoading && pendingThemeId === theme.id"
                class="loading-spinner"
              />
            </div>
          </div>
          
          <p class="theme-description-small">{{ theme.description }}</p>
          
          <div class="theme-card-footer">
            <span class="theme-author-small">{{ theme.author }}</span>
            <button 
              @click.stop="testTheme(theme.id)"
              class="test-theme-btn"
              :disabled="isLoading"
            >
              <Icon name="play" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Quick Test Section -->
    <div class="settings-section">
      <h3 class="section-title">Sound Preview</h3>
      
      <div class="sound-test-grid">
        <button
          v-for="action in testActions"
          :key="action.id"
          @click="testSound(action.id)"
          :class="['sound-test-btn', action.id]"
          :disabled="isLoading"
        >
          <Icon :name="action.icon" />
          <span>{{ action.label }}</span>
        </button>
      </div>
    </div>

    <!-- Advanced Settings -->
    <div class="settings-section advanced-section" v-if="showAdvanced">
      <h3 class="section-title">Advanced</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Clear Audio Cache</h4>
          <p class="setting-description">Clear cached audio files to force reload</p>
        </div>
        <div class="setting-control">
          <button @click="clearCache" class="clear-cache-btn">
            Clear Cache
          </button>
        </div>
      </div>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Cache Info</h4>
          <p class="setting-description">{{ cacheInfo }}</p>
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
import { ref, computed, onMounted, watch } from 'vue'
import { useThemeStore } from '@/stores/useTheme'
import { audioThemeManager } from '@/services/AudioThemeManager'
import Icon from '@/components/common/Icon.vue'
import type { AudioAction } from '@/types'

const themeStore = useThemeStore()

// Local state
const isLoading = ref(false)
const pendingThemeId = ref<string | null>(null)
const localVolume = ref(70)
const showAdvanced = ref(false)

// Computed properties
const currentTheme = computed(() => themeStore.getCurrentAudioTheme)
const currentThemeId = computed(() => themeStore.currentAudioTheme)
const availableThemes = computed(() => themeStore.audioThemes)

const cacheInfo = computed(() => {
  const size = audioThemeManager.getCacheSize()
  return `${size} audio files cached`
})

// Test actions for sound preview
const testActions = ref([
  { id: 'mention' as AudioAction, label: 'Mention', icon: 'at-sign' },
  { id: 'dm' as AudioAction, label: 'Message', icon: 'message-circle' },
  { id: 'reaction' as AudioAction, label: 'Reaction', icon: 'heart' },
  { id: 'voice_connect' as AudioAction, label: 'Voice Join', icon: 'mic' },
  { id: 'ui_success' as AudioAction, label: 'Success', icon: 'check' },
  { id: 'ui_error' as AudioAction, label: 'Error', icon: 'x' }
])

// Methods
const getThemeIcon = (themeId: string): string => {
  const icons: Record<string, string> = {
    'harmony': '🎵',
    'professional': '💼',
    'default': '🔊'
  }
  return icons[themeId] || '🎧'
}

const selectTheme = async (themeId: string): Promise<void> => {
  if (themeId === currentThemeId.value || isLoading.value) return
  
  isLoading.value = true
  pendingThemeId.value = themeId
  
  try {
    await themeStore.setAudioTheme(themeId)
  } catch (error) {
    console.error('Failed to set theme:', error)
  } finally {
    isLoading.value = false
    pendingThemeId.value = null
  }
}

const testTheme = async (themeId: string): Promise<void> => {
  // Temporarily switch to theme for testing
  const originalTheme = currentThemeId.value
  
  try {
    audioThemeManager.setTheme(themeId)
    await testSound('mention')
  } finally {
    // Switch back to original theme
    audioThemeManager.setTheme(originalTheme)
  }
}

const testCurrentTheme = (): void => {
  testSound('mention')
}

const testSound = async (action: AudioAction): Promise<void> => {
  try {
    await themeStore.testAudio(action)
  } catch (error) {
    console.error('Failed to test sound:', error)
  }
}

const onVolumeChange = (): void => {
  themeStore.setAudioVolume(localVolume.value / 100)
}

const clearCache = (): void => {
  themeStore.clearAudioCache()
  // Show feedback
  testSound('ui_success')
}

// Initialize
onMounted(async () => {
  await themeStore.initialize()
  localVolume.value = Math.round(themeStore.audioVolume * 100)
})

// Watch for volume changes from store
watch(() => themeStore.audioVolume, (newVolume) => {
  localVolume.value = Math.round(newVolume * 100)
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
