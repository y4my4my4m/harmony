<template>
  <div class="appearance-settings">
    <div class="settings-header">
      <h2 class="settings-title">Appearance</h2>
      <p class="settings-description">
        Customize how Harmony looks and feels.
      </p>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Theme</h3>
      
      <div class="theme-options">
        <div
          v-for="theme in themes"
          :key="theme.id"
          class="theme-option"
          :class="{ active: settings.theme === theme.id }"
          @click="selectTheme(theme.id)"
        >
          <div class="theme-preview" :style="{ backgroundColor: theme.id === 'custom' ? settings.customAccentColor : theme.preview }">
            <div class="theme-preview-content">
              <div class="preview-header" :style="{ backgroundColor: theme.id === 'custom' ? settings.customAccentColor : theme.headerColor }"></div>
              <div class="preview-sidebar" :style="{ backgroundColor: theme.id === 'custom' ? settings.customAccentColor : theme.sidebarColor }"></div>
              <div class="preview-chat" :style="{ backgroundColor: theme.id === 'custom' ? settings.customAccentColor : theme.chatColor }"></div>
            </div>
          </div>
          <div class="theme-info">
            <h4 class="theme-name">{{ theme.name }}</h4>
            <p class="theme-description">{{ theme.description }}</p>
          </div>
        </div>
      </div>
      
      <!-- Custom Color Picker -->
      <div v-if="settings.theme === 'custom'" class="custom-color-section">
        <h4 class="section-subtitle">Custom Theme Color</h4>
        <p class="section-help">Choose an accent color. The app will automatically generate a complete theme based on your choice.</p>
        <ColorPicker 
          v-model:color="settings.customAccentColor"
          @change="onCustomColorChange"
        />
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Font Settings</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Font Size</h4>
          <p class="setting-description">Adjust the size of text in messages.</p>
        </div>
        <div class="setting-control">
          <div class="font-size-slider">
            <input
              v-model="settings.fontSize"
              type="range"
              min="12"
              max="20"
              step="1"
              class="slider"
              @input="onFontSizeChange"
            />
            <div class="font-size-display">{{ settings.fontSize }}px</div>
          </div>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Zoom Level</h4>
          <p class="setting-description">Change the zoom level of the entire app.</p>
        </div>
        <div class="setting-control">
          <div class="zoom-controls">
            <button 
              class="zoom-btn"
              @click="adjustZoom(-10)"
              :disabled="settings.zoomLevel <= 50"
            >
              -
            </button>
            <span class="zoom-display">{{ settings.zoomLevel }}%</span>
            <button 
              class="zoom-btn"
              @click="adjustZoom(10)"
              :disabled="settings.zoomLevel >= 200"
            >
              +
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Chat Display</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Message Display</h4>
          <p class="setting-description">Choose how messages are displayed.</p>
        </div>
        <div class="setting-control">
          <select 
            v-model="settings.messageDisplay"
            class="select-input"
            @change="onSettingChange"
          >
            <option value="cozy">Cozy</option>
            <option value="compact">Compact</option>
          </select>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Show message timestamps</h4>
          <p class="setting-description">Display timestamps on messages.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.showTimestamps"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">24-Hour Time</h4>
          <p class="setting-description">Display time in 24-hour format.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.use24HourTime"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Compact Mode</h4>
          <p class="setting-description">Show more messages at once with reduced spacing.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.compactMode"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Floating Video Player</h4>
          <p class="setting-description">Playing videos float to corner when scrolled away. Works with YouTube and native videos.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.floatingVideoEnabled"
            @change="onFloatingVideoChange"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Accessibility</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">High Contrast</h4>
          <p class="setting-description">Increase contrast for better visibility.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.highContrast"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Reduce Motion</h4>
          <p class="setting-description">Reduce animations and transitions.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.reduceMotion"
            @change="onSettingChange"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Screen Reader Support</h4>
          <p class="setting-description">Optimize for screen readers.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch 
            v-model="settings.screenReaderSupport"
            @change="onSettingChange"
          />
        </div>
      </div>
    </div>

    <div class="settings-actions">
      <button 
        class="btn btn-primary" 
        @click="saveSettings"
        :disabled="loading || !hasChanges"
      >
        <span v-if="loading" class="loading-spinner"></span>
        Save Changes
      </button>
      <button 
        class="btn btn-secondary" 
        @click="resetSettings"
        :disabled="loading || !hasChanges"
      >
        Reset
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import type { User } from '@/types'
import { useFloatingVideo } from '@/composables/useFloatingVideo'
import { useVisualTheme } from '@/composables/useVisualTheme'

// Components
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import ColorPicker from '@/components/common/ColorPicker.vue'

// Props
interface Props {
  profile: User | null
  loading: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'update-appearance': [settings: any]
}>()

// Composables
const { isEnabled: floatingVideoEnabled, setEnabled: setFloatingVideoEnabled } = useFloatingVideo()
const visualTheme = useVisualTheme()

// State
const settings = ref({
  theme: 'dark' as 'dark' | 'light' | 'midnight' | 'custom',
  customAccentColor: '#5865f2',
  fontSize: 14,
  zoomLevel: 100,
  messageDisplay: 'cozy' as 'cozy' | 'compact',
  showTimestamps: true,
  use24HourTime: false,
  compactMode: false,
  floatingVideoEnabled: floatingVideoEnabled.value,
  highContrast: false,
  reduceMotion: false,
  screenReaderSupport: false,
})

const originalSettings = ref({ ...settings.value })
const showColorPicker = ref(false)

// Theme options
const themes = [
  {
    id: 'dark',
    name: 'Dark',
    description: 'A dark theme that\'s easier on the eyes.',
    preview: '#36393f',
    headerColor: '#2f3136',
    sidebarColor: '#2f3136',
    chatColor: '#36393f'
  },
  {
    id: 'light',
    name: 'Light',
    description: 'A clean, bright theme.',
    preview: '#ffffff',
    headerColor: '#f6f6f6',
    sidebarColor: '#f2f3f5',
    chatColor: '#ffffff'
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'An even darker theme for late night usage.',
    preview: '#1e2124',
    headerColor: '#1a1d20',
    sidebarColor: '#1a1d20',
    chatColor: '#1e2124'
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Create your own theme with a custom color.',
    preview: '#5865f2',
    headerColor: '#4752c4',
    sidebarColor: '#4752c4',
    chatColor: '#5865f2'
  }
]

// Computed
const hasChanges = computed(() => {
  return JSON.stringify(settings.value) !== JSON.stringify(originalSettings.value)
})

// Methods
const selectTheme = (themeId: string) => {
  settings.value.theme = themeId as 'dark' | 'light' | 'midnight' | 'custom'
  applyThemeImmediately()
}

const onCustomColorChange = (color: string) => {
  settings.value.customAccentColor = color
  applyThemeImmediately()
}

const onFontSizeChange = () => {
  applyThemeImmediately()
}

const adjustZoom = (delta: number) => {
  const newZoom = settings.value.zoomLevel + delta
  if (newZoom >= 50 && newZoom <= 200) {
    settings.value.zoomLevel = newZoom
    applyThemeImmediately()
  }
}

const onFloatingVideoChange = () => {
  setFloatingVideoEnabled(settings.value.floatingVideoEnabled)
}

const applyThemeImmediately = () => {
  // Apply to visual theme system
  visualTheme.updateSettings({
    theme: settings.value.theme,
    customAccentColor: settings.value.customAccentColor,
    fontSize: settings.value.fontSize,
    zoomLevel: settings.value.zoomLevel,
    messageDisplay: settings.value.messageDisplay,
    showTimestamps: settings.value.showTimestamps,
    use24HourTime: settings.value.use24HourTime,
    compactMode: settings.value.compactMode,
    highContrast: settings.value.highContrast,
    reduceMotion: settings.value.reduceMotion,
    screenReaderSupport: settings.value.screenReaderSupport,
  })
}

const saveSettings = () => {
  emit('update-appearance', settings.value)
  originalSettings.value = { ...settings.value }
  
  // Apply all settings through visual theme system
  applyThemeImmediately()
}

const resetSettings = () => {
  settings.value = { ...originalSettings.value }
  applyThemeImmediately()
}

// Initialize
onMounted(async () => {
  // Initialize visual theme system
  await visualTheme.initialize()
  
  // Load current settings from visual theme system
  const currentSettings = visualTheme.currentSettings.value
  settings.value = {
    theme: currentSettings.theme,
    customAccentColor: currentSettings.customAccentColor || '#5865f2',
    fontSize: currentSettings.fontSize,
    zoomLevel: currentSettings.zoomLevel,
    messageDisplay: currentSettings.messageDisplay,
    showTimestamps: currentSettings.showTimestamps,
    use24HourTime: currentSettings.use24HourTime,
    compactMode: currentSettings.compactMode,
    floatingVideoEnabled: floatingVideoEnabled.value,
    highContrast: currentSettings.highContrast,
    reduceMotion: currentSettings.reduceMotion,
    screenReaderSupport: currentSettings.screenReaderSupport,
  }
  originalSettings.value = { ...settings.value }
  
  // Watch for changes and apply in real-time
  watch(settings, (newSettings) => {
    visualTheme.updateSettings({
      theme: newSettings.theme,
      customAccentColor: newSettings.customAccentColor,
      fontSize: newSettings.fontSize,
      zoomLevel: newSettings.zoomLevel,
      messageDisplay: newSettings.messageDisplay,
      showTimestamps: newSettings.showTimestamps,
      use24HourTime: newSettings.use24HourTime,
      compactMode: newSettings.compactMode,
      highContrast: newSettings.highContrast,
      reduceMotion: newSettings.reduceMotion,
      screenReaderSupport: newSettings.screenReaderSupport,
    })
  }, { deep: true })
})
</script>

<style scoped>
.appearance-settings {
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

.theme-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.theme-option {
  border: 2px solid var(--h-chat-light);
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.theme-option:hover {
  border-color: #5865f2;
}

.theme-option.active {
  border-color: #5865f2;
  background-color: rgba(88, 101, 242, 0.1);
}

.theme-preview {
  width: 100%;
  height: 80px;
  border-radius: 4px;
  margin-bottom: 12px;
  position: relative;
  overflow: hidden;
}

.theme-preview-content {
  width: 100%;
  height: 100%;
  position: relative;
}

.preview-header {
  height: 20px;
  width: 100%;
  opacity: 0.8;
}

.preview-sidebar {
  width: 30%;
  height: 60px;
  position: absolute;
  top: 20px;
  left: 0;
  opacity: 0.9;
}

.preview-chat {
  width: 70%;
  height: 60px;
  position: absolute;
  top: 20px;
  right: 0;
}

.theme-info {
  text-align: center;
}

.theme-name {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 4px 0;
}

.theme-description {
  font-size: 12px;
  color: #b9bbbe;
  margin: 0;
}

.custom-color-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--h-chat-light);
}

.section-subtitle {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.section-help {
  font-size: 12px;
  color: #b9bbbe;
  margin: 0 0 16px 0;
  line-height: 1.5;
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

.font-size-slider {
  display: flex;
  align-items: center;
  gap: 12px;
}

.slider {
  width: 120px;
  height: 4px;
  border-radius: 2px;
  background: #4f545c;
  outline: none;
  appearance: none;
}

.slider::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #5865f2;
  cursor: pointer;
}

.slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #5865f2;
  cursor: pointer;
  border: none;
}

.font-size-display {
  font-size: 12px;
  color: #b9bbbe;
  min-width: 40px;
  text-align: center;
}

.zoom-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.zoom-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--h-chat-light);
  background-color: var(--h-chat-darker);
  color: #ffffff;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  transition: all 0.15s ease;
}

.zoom-btn:hover:not(:disabled) {
  background-color: var(--h-chat-light);
}

.zoom-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.zoom-display {
  font-size: 14px;
  color: #ffffff;
  min-width: 60px;
  text-align: center;
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

.select-input:focus {
  outline: none;
  border-color: #5865f2;
}

.settings-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.btn {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background-color: #5865f2;
  color: #ffffff;
}

.btn-primary:hover:not(:disabled) {
  background-color: #4752c4;
}

.btn-secondary {
  background-color: transparent;
  color: #b9bbbe;
  border: 1px solid #4f545c;
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid #ffffff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .settings-section {
    padding: 16px;
  }
  
  .theme-options {
    grid-template-columns: 1fr;
  }
  
  .setting-item {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  
  .setting-info {
    margin-right: 0;
  }
  
  .font-size-slider {
    justify-content: space-between;
  }
}
</style>