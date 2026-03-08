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

      <!-- Community Presets -->
      <div class="community-presets-section">
        <h4 class="section-subtitle">Community Presets</h4>
        <p class="section-help">Quick-apply curated themes from the community</p>
        <div class="presets-grid">
          <button
            v-for="preset in communityPresets"
            :key="preset.name"
            class="preset-card"
            @click="applyPresetTheme(preset)"
          >
            <div class="preset-swatch" :style="{ background: preset.settings.customPrimaryColor }"></div>
            <div class="preset-info">
              <span class="preset-name">{{ preset.name }}</span>
              <span class="preset-desc">{{ preset.description }}</span>
            </div>
          </button>
        </div>
      </div>

      <!-- Import / Export -->
      <div class="theme-import-export-section">
        <h4 class="section-subtitle">Import & Export</h4>
        <p class="section-help">Export your theme as JSON or import a previously exported theme</p>
        <div class="import-export-buttons">
          <button class="preset-card export-btn" @click="exportTheme">
            Export theme
          </button>
          <button class="preset-card import-btn" @click="triggerImportInput">
            Import theme
          </button>
          <input
            ref="importFileInput"
            type="file"
            accept=".json,application/json"
            class="hidden-file-input"
            @change="handleImportFile"
          />
        </div>
      </div>

      <!-- My Saved Themes -->
      <div class="saved-themes-section">
        <h4 class="section-subtitle">My saved themes</h4>
        <p class="section-help">Save your current theme to switch between them later</p>
        <div class="save-theme-row">
          <input
            v-model="savedThemeName"
            type="text"
            class="theme-name-input"
            placeholder="Theme name"
          />
          <button class="save-theme-btn" @click="saveCurrentTheme" :disabled="!savedThemeName?.trim()">
            Save theme
          </button>
        </div>
        <div v-if="savedThemesList.length > 0" class="saved-themes-list">
          <div v-for="t in savedThemesList" :key="t.id" class="saved-theme-item">
            <span class="saved-theme-name">{{ t.name }}</span>
            <div class="saved-theme-actions">
              <button class="apply-theme-btn" @click="applySavedTheme(t.id)">Apply</button>
              <button class="delete-theme-btn" @click="deleteSavedThemeItem(t.id)">Delete</button>
            </div>
          </div>
        </div>
        <p v-else class="section-help muted">No saved themes yet</p>
      </div>

      <!-- Advanced CSS Variable Overrides -->
      <div v-if="settings.theme === 'custom'" class="advanced-css-section">
        <button class="toggle-advanced-btn" @click="showAdvancedCss = !showAdvancedCss">
          {{ showAdvancedCss ? 'Hide' : 'Show' }} Advanced CSS Variables
          <span class="toggle-arrow" :class="{ open: showAdvancedCss }">&#9660;</span>
        </button>

        <div v-if="showAdvancedCss" class="css-overrides-panel">
          <p class="section-help">Override individual CSS variables for full control. Changes apply in real-time.</p>
          <div
            v-for="group in themableVariables"
            :key="group.category"
            class="css-var-group"
          >
            <h5 class="var-group-title">{{ group.category }}</h5>
            <div class="var-list">
              <div v-for="varName in group.vars" :key="varName" class="var-item">
                <label class="var-name">{{ varName }}</label>
                <div class="var-controls">
                  <input
                    type="color"
                    class="var-color-input"
                    :value="getCssVarValue(varName)"
                    @input="setCssOverrideFromInput(varName, ($event.target as HTMLInputElement).value)"
                  />
                  <input
                    type="text"
                    class="var-text-input"
                    :value="settings.customCssOverrides?.[varName] || ''"
                    :placeholder="getComputedVar(varName)"
                    @change="setCssOverrideFromInput(varName, ($event.target as HTMLInputElement).value)"
                  />
                  <button
                    v-if="settings.customCssOverrides?.[varName]"
                    class="var-reset-btn"
                    @click="removeCssOverrideVar(varName)"
                    title="Reset to default"
                  >
                    &#10005;
                  </button>
                </div>
              </div>
            </div>
          </div>
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
      <h3 class="section-title">Emoji Style</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Emoji Pack</h4>
          <p class="setting-description">Choose which emoji style to use throughout the app</p>
        </div>
        <div class="setting-control">
          <div class="emoji-pack-options">
            <button
              class="emoji-pack-btn"
              :class="{ active: settings.emojiPack === 'twemoji' }"
              @click="settings.emojiPack = 'twemoji'; onEmojiPackChange()"
            >
              <img 
                src="/assets/emojis/twemoji/1f600.svg" 
                alt="Twemoji" 
                class="pack-preview"
              />
              <span>Twemoji</span>
            </button>
            <button
              class="emoji-pack-btn"
              :class="{ active: settings.emojiPack === 'mutant' }"
              @click="settings.emojiPack = 'mutant'; onEmojiPackChange()"
            >
              <img 
                src="/assets/emojis/mutant_emojis_svg/expressions/smileys/typical/grinning.svg" 
                alt="Mutant" 
                class="pack-preview"
              />
              <span>Mutant Standard</span>
            </button>
            <button
              class="emoji-pack-btn"
              :class="{ active: settings.emojiPack === 'native' }"
              @click="settings.emojiPack = 'native'; onEmojiPackChange()"
            >
              <span class="pack-preview-native">😀</span>
              <span>System</span>
            </button>
          </div>
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
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import type { User } from '@/types'
import { useFloatingVideo } from '@/composables/useFloatingVideo'
import { useVisualTheme } from '@/composables/useVisualTheme'
import { generateThemePalette, applyThemePalette, generatePreviewColors } from '@/utils/colorUtils'
import { useEmojiPacks } from '@/services/emojiPackService'

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
const { currentPackId, packs, setCurrentPack } = useEmojiPacks()

// State
const settings = ref({
  theme: 'dark' as 'dark' | 'light' | 'midnight' | 'custom',
  customThemeMode: 'dark' as 'dark' | 'light',
  customPrimaryColor: '#5865f2',
  customAccentColor: '#5865f2',
  customBackgroundColor: '#5865f2',
  customBackgroundLightness: 0,
  customBackgroundChroma: 0,
  customCssOverrides: {} as Record<string, string>,
  fontSize: 14,
  zoomLevel: 100,
  showTimestamps: true,
  use24HourTime: false,
  compactMode: false,
  floatingVideoEnabled: floatingVideoEnabled.value,
  highContrast: false,
  reduceMotion: false,
  screenReaderSupport: false,
  emojiPack: currentPackId.value as 'twemoji' | 'mutant' | 'native',
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
const showAdvancedCss = ref(false)
const savedThemeName = ref('')
const importFileInput = ref<HTMLInputElement | null>(null)
const toast = useToast()

// Saved themes (refresh when we need to show the list)
const savedThemesList = ref(visualTheme.getSavedCustomThemes())

function refreshSavedThemes() {
  savedThemesList.value = visualTheme.getSavedCustomThemes()
}

function exportTheme() {
  const json = visualTheme.exportThemeAsJson()
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `harmony-theme-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
  toast.success('Theme exported')
}

function triggerImportInput() {
  importFileInput.value?.click()
}

function handleImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const text = reader.result as string
    if (visualTheme.importThemeFromJson(text)) {
      Object.assign(settings.value, visualTheme.currentSettings.value)
      previewTheme()
      toast.success('Theme imported')
    } else {
      toast.error('Invalid theme file')
    }
  }
  reader.readAsText(file)
  input.value = ''
}

function saveCurrentTheme() {
  const name = savedThemeName.value?.trim()
  if (!name) return
  const theme = visualTheme.saveCurrentThemeAsCustom(name)
  if (theme) {
    savedThemeName.value = ''
    refreshSavedThemes()
    toast.success(`"${theme.name}" saved`)
  }
}

function applySavedTheme(id: string) {
  if (visualTheme.loadSavedTheme(id)) {
    Object.assign(settings.value, visualTheme.currentSettings.value)
    previewTheme()
    toast.success('Theme applied')
  }
}

function deleteSavedThemeItem(id: string) {
  visualTheme.deleteSavedTheme(id)
  refreshSavedThemes()
  toast.success('Theme removed')
}

// Import community presets and theme helpers
import { COMMUNITY_PRESETS, type ThemePreset } from '@/composables/useVisualTheme'
const communityPresets = COMMUNITY_PRESETS
const themableVariables = visualTheme.getThemableVariables()

const applyPresetTheme = (preset: ThemePreset) => {
  visualTheme.applyPreset(preset)
  Object.assign(settings.value, preset.settings)
}

const getCssVarValue = (varName: string): string => {
  if (settings.value.customCssOverrides?.[varName]) {
    return settings.value.customCssOverrides[varName]
  }
  return getComputedVar(varName)
}

const getComputedVar = (varName: string): string => {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || ''
}

const setCssOverrideFromInput = (varName: string, value: string) => {
  if (!value) return
  visualTheme.setCssOverride(varName, value)
  if (!settings.value.customCssOverrides) settings.value.customCssOverrides = {}
  settings.value.customCssOverrides[varName] = value
}

const removeCssOverrideVar = (varName: string) => {
  visualTheme.removeCssOverride(varName)
  if (settings.value.customCssOverrides) {
    delete settings.value.customCssOverrides[varName]
  }
  onCustomColorChange()
}

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
      debug.error('Failed to preview custom theme:', error)
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

const onEmojiPackChange = () => {
  setCurrentPack(settings.value.emojiPack)
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
    emojiPack: currentPackId.value as 'mutant' | 'native',
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
  color: var(--text-secondary, var(--text-secondary));
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
  color: var(--text-secondary, var(--text-secondary));
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
  color: var(--text-secondary, var(--text-secondary));
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
  color: var(--text-secondary, var(--text-secondary));
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

/* Emoji pack selector */
.emoji-pack-options {
  display: flex;
  gap: 12px;
}

.emoji-pack-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  border: 2px solid var(--h-chat-light);
  background-color: var(--h-chat-darker);
  color: var(--text-secondary, var(--text-secondary));
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.2s ease;
  min-width: 120px;
}

.emoji-pack-btn:hover {
  border-color: var(--h-primary, #5865f2);
  background-color: var(--h-chat-light);
}

.emoji-pack-btn.active {
  border-color: var(--h-primary, #5865f2);
  background-color: rgba(88, 101, 242, 0.15);
  color: var(--text-primary, #ffffff);
}

.pack-preview {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.pack-preview-native {
  font-size: 32px;
  line-height: 1;
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
  color: var(--text-secondary, var(--text-secondary));
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
  color: var(--text-secondary, var(--text-secondary));
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
  color: var(--text-secondary, var(--text-secondary));
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
  color: var(--text-secondary, var(--text-secondary));
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
  background: var(--background-quaternary);
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
  color: var(--text-secondary, var(--text-secondary));
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
  color: var(--text-secondary, var(--text-secondary));
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

/* Community Presets */
.community-presets-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--h-chat-light);
}

.presets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.preset-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--h-chat);
  border: 1px solid var(--h-chat-light);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
  color: inherit;
}

.preset-card:hover {
  border-color: var(--harmony-primary);
  transform: translateY(-1px);
}

.preset-swatch {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  flex-shrink: 0;
}

.preset-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.preset-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.preset-desc {
  font-size: 11px;
  color: var(--text-secondary);
}

/* Import / Export */
.theme-import-export-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--h-chat-light);
}

.import-export-buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.export-btn,
.import-btn {
  min-width: 120px;
}

.hidden-file-input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

/* My saved themes */
.saved-themes-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--h-chat-light);
}

.save-theme-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.theme-name-input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid var(--h-chat-light);
  background: var(--h-chat);
  color: var(--text-primary);
  border-radius: 6px;
  font-size: 14px;
}

.theme-name-input::placeholder {
  color: var(--text-tertiary);
}

.save-theme-btn {
  padding: 10px 20px;
  background: var(--harmony-primary);
  color: white;
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.save-theme-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.save-theme-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.saved-themes-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.saved-theme-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--h-chat);
  border: 1px solid var(--h-chat-light);
  border-radius: 6px;
}

.saved-theme-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.saved-theme-actions {
  display: flex;
  gap: 8px;
}

.apply-theme-btn,
.delete-theme-btn {
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.apply-theme-btn {
  background: var(--harmony-primary);
  color: white;
  border: none;
}

.apply-theme-btn:hover {
  filter: brightness(1.1);
}

.delete-theme-btn {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--h-chat-light);
}

.delete-theme-btn:hover {
  color: var(--error, #ed4245);
  border-color: var(--error, #ed4245);
}

.section-help.muted {
  color: var(--text-tertiary);
  font-style: italic;
}

/* Advanced CSS Variables */
.advanced-css-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--h-chat-light);
}

.toggle-advanced-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  background: none;
  border: 1px solid var(--h-chat-light);
  color: var(--text-secondary);
  padding: 10px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  width: 100%;
  justify-content: center;
  transition: all 0.2s;
}

.toggle-advanced-btn:hover {
  background: var(--h-chat-light);
  color: var(--text-primary);
}

.toggle-arrow {
  font-size: 10px;
  transition: transform 0.2s;
}

.toggle-arrow.open {
  transform: rotate(180deg);
}

.css-overrides-panel {
  margin-top: 16px;
}

.css-var-group {
  margin-bottom: 20px;
}

.var-group-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0 0 10px;
}

.var-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.var-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 8px;
  border-radius: 4px;
}

.var-item:hover {
  background: var(--h-chat-light);
}

.var-name {
  font-size: 12px;
  font-family: monospace;
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 180px;
}

.var-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  justify-content: flex-end;
}

.var-color-input {
  width: 28px;
  height: 28px;
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  padding: 2px;
  cursor: pointer;
  background: none;
}

.var-text-input {
  width: 100px;
  padding: 4px 8px;
  background: var(--h-chat-dark, #141618);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 11px;
  font-family: monospace;
}

.var-text-input::placeholder {
  color: var(--text-muted);
}

.var-reset-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 4px;
}

.var-reset-btn:hover {
  color: var(--error);
  background: rgba(237, 66, 69, 0.1);
}
</style>