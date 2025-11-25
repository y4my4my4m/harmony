<template>
  <div class="appearance-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.appearance.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.appearance.description') }}
      </p>
    </div>

    <div class="settings-section">
      <h3 class="section-title">{{ $t('settings.appearance.theme') }}</h3>
      
      <div class="theme-options">
        <div
          v-for="theme in themes"
          :key="theme.id"
          class="theme-option"
          :class="{ active: settings.theme === theme.id }"
          @click="selectTheme(theme.id)"
        >
          <div class="theme-preview" :style="{ backgroundColor: theme.id === 'custom' ? customPreviewColors.bgMain : theme.preview }">
            <div class="theme-preview-content">
              <div class="preview-header" :style="{ backgroundColor: theme.id === 'custom' ? customPreviewColors.bgHeader : theme.headerColor }"></div>
              <div class="preview-sidebar" :style="{ backgroundColor: theme.id === 'custom' ? customPreviewColors.bgSidebar : theme.sidebarColor }"></div>
              <div class="preview-chat" :style="{ backgroundColor: theme.id === 'custom' ? customPreviewColors.bgMain : theme.chatColor }"></div>
              <!-- Show accent color dot for custom theme -->
              <div v-if="theme.id === 'custom'" class="preview-accent-dot" :style="{ backgroundColor: settings.customPrimaryColor }"></div>
            </div>
          </div>
          <div class="theme-info">
            <h4 class="theme-name">{{ $t(`settings.appearance.themes.${theme.id}`) }}</h4>
            <p class="theme-description">{{ $t(`settings.appearance.themes.${theme.id}Desc`) }}</p>
          </div>
        </div>
      </div>
      
      <!-- Custom Color Picker -->
      <div v-if="settings.theme === 'custom'" class="custom-color-section">
        <h4 class="section-subtitle">{{ $t('settings.appearance.customTheme') }}</h4>
        <p class="section-help">{{ $t('settings.appearance.customThemeHelp') }}</p>
        
        <!-- Theme Mode Selector -->
        <div class="custom-theme-mode">
          <label class="mode-label">Theme Mode</label>
          <div class="mode-options">
            <button
              class="mode-btn"
              :class="{ active: settings.customThemeMode === 'dark' }"
              @click="settings.customThemeMode = 'dark'; onCustomColorChange()"
            >
              🌙 Dark
            </button>
            <button
              class="mode-btn"
              :class="{ active: settings.customThemeMode === 'light' }"
              @click="settings.customThemeMode = 'light'; onCustomColorChange()"
            >
              ☀️ Light
            </button>
          </div>
        </div>
        
        <!-- Background Tone Color -->
        <div class="color-picker-section">
          <label class="picker-label">Background Tone</label>
          <p class="picker-help">Sets the color hue for all background elements</p>
          <ColorPicker 
            v-model:color="settings.customBackgroundColor"
            @update:color="onCustomBackgroundChange"
            @change="onCustomBackgroundChange"
          />
        </div>
        
        <!-- Background Lightness -->
        <div class="lightness-section">
          <label class="picker-label">Background Lightness</label>
          <p class="picker-help">Adjust how light or dark the backgrounds appear</p>
          <div class="lightness-slider-container">
            <span class="lightness-label">Darker</span>
            <input
              v-model.number="settings.customBackgroundLightness"
              type="range"
              min="-50"
              max="50"
              step="1"
              class="lightness-slider"
              @input="onLightnessChange"
            />
            <span class="lightness-label">Lighter</span>
          </div>
          <div class="lightness-value">{{ settings.customBackgroundLightness > 0 ? '+' : '' }}{{ settings.customBackgroundLightness }}</div>
        </div>
        
        <!-- Background Chroma (Saturation) -->
        <div class="chroma-section">
          <label class="picker-label">Background Saturation</label>
          <p class="picker-help">Adjust color intensity of the backgrounds</p>
          <div class="chroma-slider-container">
            <span class="chroma-label">Muted</span>
            <input
              v-model.number="settings.customBackgroundChroma"
              type="range"
              min="-30"
              max="30"
              step="1"
              class="chroma-slider"
              @input="onChromaChange"
            />
            <span class="chroma-label">Vivid</span>
          </div>
          <div class="chroma-value">{{ settings.customBackgroundChroma > 0 ? '+' : '' }}{{ settings.customBackgroundChroma }}</div>
        </div>
        
        <!-- Primary Color -->
        <div class="color-picker-section">
          <label class="picker-label">Primary Color</label>
          <p class="picker-help">Main brand color for buttons and key actions</p>
          <ColorPicker 
            v-model:color="settings.customPrimaryColor"
            @update:color="onCustomColorChange"
            @change="onCustomColorChange"
          />
        </div>
        
        <!-- Secondary/Accent Color -->
        <div class="color-picker-section">
          <label class="picker-label">Secondary Color</label>
          <p class="picker-help">Used for links, highlights, and accents</p>
          <ColorPicker 
            v-model:color="settings.customAccentColor"
            @update:color="onCustomColorChange"
            @change="onCustomColorChange"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">{{ $t('settings.appearance.fontSize') }}</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('settings.appearance.fontSize') }}</h4>
          <p class="setting-description">{{ $t('settings.appearance.fontSizeDesc') }}</p>
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
          <h4 class="setting-label">{{ $t('settings.appearance.zoomLevel') }}</h4>
          <p class="setting-description">{{ $t('settings.appearance.zoomLevelDesc') }}</p>
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
      <h3 class="section-title">{{ $t('settings.appearance.messageDisplay') }}</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('settings.appearance.showTimestamps') }}</h4>
          <p class="setting-description">{{ $t('settings.appearance.showTimestampsDesc') }}</p>
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
          <h4 class="setting-label">{{ $t('settings.appearance.use24Hour') }}</h4>
          <p class="setting-description">{{ $t('settings.appearance.use24HourDesc') }}</p>
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
          <h4 class="setting-label">{{ $t('settings.appearance.compactMode') }}</h4>
          <p class="setting-description">{{ $t('settings.appearance.compactModeDesc') }}</p>
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
          <h4 class="setting-label">{{ $t('settings.appearance.floatingVideo') }}</h4>
          <p class="setting-description">{{ $t('settings.appearance.floatingVideoDesc') }}</p>
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
      <h3 class="section-title">{{ $t('settings.appearance.highContrast') }}</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('settings.appearance.highContrast') }}</h4>
          <p class="setting-description">{{ $t('settings.appearance.highContrastDesc') }}</p>
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
          <h4 class="setting-label">{{ $t('settings.appearance.reduceMotion') }}</h4>
          <p class="setting-description">{{ $t('settings.appearance.reduceMotionDesc') }}</p>
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
          <h4 class="setting-label">{{ $t('settings.appearance.screenReader') }}</h4>
          <p class="setting-description">{{ $t('settings.appearance.screenReaderDesc') }}</p>
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
        {{ $t('settings.appearance.saveChanges') }}
      </button>
      <button 
        class="btn btn-secondary" 
        @click="resetSettings"
        :disabled="loading || !hasChanges"
      >
        {{ $t('settings.appearance.resetSettings') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import type { User } from '@/types'
import { useFloatingVideo } from '@/composables/useFloatingVideo'
import { useVisualTheme } from '@/composables/useVisualTheme'
import { generateThemePalette, applyThemePalette, generatePreviewColors } from '@/utils/colorUtils'

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
  customThemeMode: 'dark' as 'dark' | 'light',
  customPrimaryColor: '#5865f2',
  customAccentColor: '#5865f2',
  customBackgroundColor: '#5865f2',
  customBackgroundLightness: 0,
  customBackgroundChroma: 0,
  fontSize: 14,
  zoomLevel: 100,
  showTimestamps: true,
  use24HourTime: false,
  compactMode: false,
  floatingVideoEnabled: floatingVideoEnabled.value,
  highContrast: false,
  reduceMotion: false,
  screenReaderSupport: false,
})

// Computed preview colors for custom theme
const customPreviewColors = computed(() => {
  return generatePreviewColors(
    settings.value.customBackgroundColor,
    settings.value.customThemeMode,
    settings.value.customBackgroundLightness,
    settings.value.customBackgroundChroma
  )
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
  previewTheme()
}

const onCustomColorChange = () => {
  previewTheme()
}

const onCustomBackgroundChange = () => {
  previewTheme()
}

const previewTheme = () => {
  // Apply theme immediately for preview (doesn't save)
  if (settings.value.theme === 'custom') {
    try {
      const palette = generateThemePalette(
        settings.value.customAccentColor,
        settings.value.customThemeMode,
        settings.value.customBackgroundColor,
        settings.value.customBackgroundLightness,
        settings.value.customPrimaryColor,
        settings.value.customBackgroundChroma
      )
      applyThemePalette(palette)
    } catch (error) {
      console.error('Failed to preview custom theme:', error)
    }
  } else {
    visualTheme.setTheme(settings.value.theme)
  }
}

const onLightnessChange = () => {
  previewTheme()
}

const onChromaChange = () => {
  previewTheme()
}

const onFontSizeChange = () => {
  visualTheme.setFontSize(settings.value.fontSize)
}

const adjustZoom = (delta: number) => {
  const newZoom = settings.value.zoomLevel + delta
  if (newZoom >= 50 && newZoom <= 200) {
    settings.value.zoomLevel = newZoom
    visualTheme.setZoomLevel(newZoom)
  }
}

const onFloatingVideoChange = () => {
  setFloatingVideoEnabled(settings.value.floatingVideoEnabled)
}

const onSettingChange = () => {
  // Settings changed - will auto-save via composable
}

const saveSettings = () => {
  emit('update-appearance', settings.value)
  originalSettings.value = { ...settings.value }
  
  // Now actually save to composable (persists to localStorage and Supabase)
  visualTheme.updateSettings({
    theme: settings.value.theme,
    customThemeMode: settings.value.customThemeMode,
    customPrimaryColor: settings.value.customPrimaryColor,
    customAccentColor: settings.value.customAccentColor,
    customBackgroundColor: settings.value.customBackgroundColor,
    customBackgroundLightness: settings.value.customBackgroundLightness,
    customBackgroundChroma: settings.value.customBackgroundChroma,
    fontSize: settings.value.fontSize,
    zoomLevel: settings.value.zoomLevel,
    showTimestamps: settings.value.showTimestamps,
    use24HourTime: settings.value.use24HourTime,
    compactMode: settings.value.compactMode,
    highContrast: settings.value.highContrast,
    reduceMotion: settings.value.reduceMotion,
    screenReaderSupport: settings.value.screenReaderSupport,
  })
}

const resetSettings = () => {
  settings.value = { ...originalSettings.value }
  
  // Reapply original settings as preview
  if (originalSettings.value.theme === 'custom') {
    previewTheme()
  } else {
    visualTheme.setTheme(originalSettings.value.theme)
  }
}

// Initialize
onMounted(async () => {
  // Initialize visual theme system
  await visualTheme.initialize()
  
  // Load current settings from visual theme system
  const currentSettings = visualTheme.currentSettings.value
  settings.value = {
    theme: currentSettings.theme,
    customThemeMode: currentSettings.customThemeMode || 'dark',
    customPrimaryColor: currentSettings.customPrimaryColor || '#5865f2',
    customAccentColor: currentSettings.customAccentColor || '#5865f2',
    customBackgroundColor: currentSettings.customBackgroundColor || '#5865f2',
    customBackgroundLightness: currentSettings.customBackgroundLightness || 0,
    customBackgroundChroma: currentSettings.customBackgroundChroma || 0,
    fontSize: currentSettings.fontSize,
    zoomLevel: currentSettings.zoomLevel,
    showTimestamps: currentSettings.showTimestamps,
    use24HourTime: currentSettings.use24HourTime,
    compactMode: currentSettings.compactMode,
    floatingVideoEnabled: floatingVideoEnabled.value,
    highContrast: currentSettings.highContrast,
    reduceMotion: currentSettings.reduceMotion,
    screenReaderSupport: currentSettings.screenReaderSupport,
  }
  originalSettings.value = { ...settings.value }
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
  color: var(--text-primary, #ffffff);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary, #b9bbbe);
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
  color: var(--text-primary, #ffffff);
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
  border-color: var(--h-primary, #5865f2);
}

.theme-option.active {
  border-color: var(--h-primary, #5865f2);
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
  color: var(--text-primary, #ffffff);
  margin: 0 0 4px 0;
}

.theme-description {
  font-size: 12px;
  color: var(--text-secondary, #b9bbbe);
  margin: 0;
}

.preview-accent-dot {
  position: absolute;
  bottom: 8px;
  right: 8px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.custom-color-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--h-chat-light);
}

.section-subtitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #ffffff);
  margin: 0 0 8px 0;
}

.section-help {
  font-size: 12px;
  color: var(--text-secondary, #b9bbbe);
  margin: 0 0 16px 0;
  line-height: 1.5;
}

.custom-theme-mode {
  margin-bottom: 24px;
}

.mode-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #ffffff);
  margin-bottom: 8px;
}

.mode-options {
  display: flex;
  gap: 12px;
}

.mode-btn {
  flex: 1;
  padding: 12px 16px;
  border: 2px solid var(--h-chat-light);
  background-color: var(--h-chat-darker);
  color: var(--text-secondary, #b9bbbe);
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s ease;
}

.mode-btn:hover {
  border-color: var(--h-primary, #5865f2);
  background-color: var(--h-chat-light);
}

.mode-btn.active {
  border-color: var(--h-primary, #5865f2);
  background-color: rgba(88, 101, 242, 0.15);
  color: var(--text-primary, #ffffff);
}

.color-picker-section {
  margin-bottom: 24px;
}

.picker-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #ffffff);
  margin-bottom: 4px;
}

.picker-help {
  font-size: 12px;
  color: var(--text-secondary, #b9bbbe);
  margin: 0 0 12px 0;
}

/* Lightness Slider */
.lightness-section {
  margin-bottom: 24px;
  padding: 16px;
  background-color: var(--h-chat-darker);
  border-radius: 8px;
  border: 1px solid var(--h-chat-light);
}

.lightness-slider-container {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.lightness-label {
  font-size: 11px;
  color: var(--text-tertiary, #80848e);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  min-width: 50px;
  text-align: center;
}

.lightness-slider {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: linear-gradient(to right, 
    oklch(15% 0.02 260), 
    oklch(50% 0.02 260), 
    oklch(85% 0.02 260)
  );
  outline: none;
  appearance: none;
  cursor: pointer;
}

.lightness-slider::-webkit-slider-thumb {
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--h-primary, #5865f2);
  cursor: pointer;
  border: 3px solid var(--text-primary, #ffffff);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  transition: transform 0.15s ease;
}

.lightness-slider::-webkit-slider-thumb:hover {
  transform: scale(1.1);
}

.lightness-slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--h-primary, #5865f2);
  cursor: pointer;
  border: 3px solid var(--text-primary, #ffffff);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.lightness-value {
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #b9bbbe);
  margin-top: 8px;
}

/* Chroma (Saturation) Slider */
.chroma-section {
  margin-bottom: 24px;
  padding: 16px;
  background-color: var(--h-chat-darker);
  border-radius: 8px;
  border: 1px solid var(--h-chat-light);
}

.chroma-slider-container {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.chroma-label {
  font-size: 11px;
  color: var(--text-tertiary, #80848e);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  min-width: 50px;
  text-align: center;
}

.chroma-slider {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: linear-gradient(to right, 
    oklch(30% 0.00 260), 
    oklch(30% 0.06 260), 
    oklch(30% 0.12 260)
  );
  outline: none;
  appearance: none;
  cursor: pointer;
}

.chroma-slider::-webkit-slider-thumb {
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--h-primary, #5865f2);
  cursor: pointer;
  border: 3px solid var(--text-primary, #ffffff);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  transition: transform 0.15s ease;
}

.chroma-slider::-webkit-slider-thumb:hover {
  transform: scale(1.1);
}

.chroma-slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--h-primary, #5865f2);
  cursor: pointer;
  border: 3px solid var(--text-primary, #ffffff);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.chroma-value {
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #b9bbbe);
  margin-top: 8px;
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
  color: var(--text-primary, #ffffff);
  margin: 0 0 4px 0;
}

.setting-description {
  font-size: 12px;
  color: var(--text-secondary, #b9bbbe);
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
  background: var(--h-primary, #5865f2);
  cursor: pointer;
}

.slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--h-primary, #5865f2);
  cursor: pointer;
  border: none;
}

.font-size-display {
  font-size: 12px;
  color: var(--text-secondary, #b9bbbe);
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
  color: var(--text-primary, #ffffff);
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
  color: var(--text-primary, #ffffff);
  min-width: 60px;
  text-align: center;
}

.select-input {
  padding: 8px 12px;
  background-color: var(--h-chat-darker);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: var(--text-primary, #ffffff);
  font-size: 14px;
  cursor: pointer;
}

.select-input:focus {
  outline: none;
  border-color: var(--h-primary, #5865f2);
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
  background-color: var(--h-primary, #5865f2);
  color: #ffffff;
}

.btn-primary:hover:not(:disabled) {
  background-color: var(--h-primary-dark, #4752c4);
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary, #b9bbbe);
  border: 1px solid var(--h-chat-light);
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
  color: var(--text-primary, #ffffff);
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