<template>
  <div :class="[{ compact }]">
    <!-- Header Section -->
    <div class="manager-header">
      <div class="header-content">
        <div class="header-icon">
          <Icon name="music" />
        </div>
        <div class="header-info">
          <h3 class="header-title">Audio Themes</h3>
          <p class="header-subtitle">
            Customize your audio experience with professional sound packs
          </p>
        </div>
      </div>
      
      <div class="header-actions">
        <button 
          v-if="showTestButton"
          @click="testCurrentTheme" 
          :class="['action-btn', 'test-btn', { loading: isTesting }]"
          :disabled="!themeStore.isReady || isTesting"
          title="Test current theme"
        >
          <Icon :name="isTesting ? 'loader' : 'play'" :class="{ spinning: isTesting }" />
        </button>
        
        <button 
          v-if="showCacheButton"
          @click="clearCache"
          class="action-btn cache-btn"
          :disabled="!themeStore.isReady"
          title="Clear audio cache"
        >
          <Icon name="refresh-cw" />
        </button>
      </div>
    </div>

    <!-- Status Bar -->
    <div v-if="showStatus" class="status-bar">
      <div :class="['status-indicator', themeStore.systemStatus]">
        <Icon 
          :name="getStatusIcon()" 
          :class="{ spinning: ['loading', 'preloading'].includes(themeStore.systemStatus) }" 
        />
        <span class="status-text">{{ getStatusText() }}</span>
      </div>
      
      <div v-if="cacheInfo" class="cache-info">
        <span class="cache-text">{{ cacheInfo.size }}/{{ cacheInfo.maxSize }} cached</span>
      </div>
    </div>

    <!-- Error Display -->
    <div v-if="themeStore.lastError" class="error-banner">
      <Icon name="alert-circle" />
      <span>{{ themeStore.lastError }}</span>
      <button @click="themeStore.clearError()" class="error-close">
        <Icon name="x" />
      </button>
    </div>

    <!-- Theme Grid -->
    <div class="theme-grid">        <div 
          v-for="theme in displayedThemes"
          :key="theme.id"
          :class="[
            'theme-card',
            { 
              active: theme.id === themeStore.currentAudioTheme,
              loading: isThemeLoading(theme.id),
              preloading: themeStore.preloadingTheme === theme.id
            }
          ]"
          @click="selectTheme(theme.id)"
          @mouseenter="preloadTheme(theme.id)"
        >
        <!-- Theme Preview Image -->
        <div class="theme-preview">
          <img 
            v-if="theme.preview" 
            :src="theme.preview" 
            :alt="theme.name"
            class="preview-image"
            loading="lazy"
          />
          <div v-else class="preview-placeholder">
            <Icon :name="getThemeIconName(theme.id)" filled />
          </div>
          
          <!-- Loading Overlay -->
          <div v-if="isThemeLoading(theme.id)" class="loading-overlay">
            <Icon name="loader" class="spinning" />
          </div>
          
          <!-- Preloading Indicator -->
          <div v-if="themeStore.preloadingTheme === theme.id" class="preload-indicator">
            <Icon name="download" class="pulsing" />
          </div>
        </div>

        <!-- Theme Info -->
        <div class="theme-info">
          <div class="theme-header">
            <h4 class="theme-name">{{ theme.name }}</h4>
            <div class="theme-meta">
              <span v-if="theme.isBuiltIn" class="built-in-badge">Built-in</span>
              <span class="theme-version">v{{ theme.version }}</span>
            </div>
          </div>
          
          <p class="theme-description">{{ theme.description }}</p>
          
          <div class="theme-footer">
            <span class="theme-author">by {{ theme.author }}</span>
            <div class="theme-actions">
              <button 
                v-if="!isThemeLoading(theme.id)" 
                @click.stop="testTheme(theme.id)"
                class="mini-action-btn"
                title="Test theme"
              >
                <Icon name="volume-2" />
              </button>
            </div>
          </div>
        </div>

        <!-- Active Indicator -->
        <div v-if="theme.id === themeStore.currentAudioTheme" class="active-indicator">
          <Icon name="check-circle" />
        </div>

        <!-- Loading Progress -->
        <div v-if="isThemeLoading(theme.id)" class="loading-progress">
          <div class="progress-bar" :style="{ width: '60%' }"></div>
        </div>
      </div>
    </div>

    <!-- Volume Control Section -->
    <div v-if="showVolumeControl" class="volume-section">
      <div class="volume-header">
        <Icon name="volume-2" />
        <span class="volume-label">Master Volume</span>
        <span class="volume-value">{{ Math.round(localVolume) }}%</span>
      </div>
      
      <div class="volume-control">
        <button 
          @click="toggleMute"
          :class="['volume-mute-btn', { muted: localVolume === 0 }]"
        >
          <Icon :name="localVolume === 0 ? 'volume-x' : 'volume-1'" />
        </button>
        
        <div class="volume-slider-container">
          <input
            v-model.number="localVolume"
            @input="onVolumeChange"
            type="range"
            min="0"
            max="100"
            step="1"
            class="volume-slider"
            :style="volumeSliderStyle"
          />
          <div class="volume-track">
            <div class="volume-fill" :style="{ width: `${localVolume}%` }"></div>
          </div>
        </div>          <div class="volume-presets">
            <button 
              v-for="preset in volumePresets"
              :key="preset.value"
              @click="setVolumePreset(preset.value)"
              :class="['preset-btn', { active: isVolumePresetActive(preset.value) }]"
              :title="preset.label"
            >
              {{ preset.value }}%
            </button>
          </div>
      </div>
    </div>

    <!-- Advanced Settings -->
    <div v-if="showAdvanced" class="advanced-section">
      <button 
        @click="showAdvancedOptions = !showAdvancedOptions"
        class="advanced-toggle"
      >
        <Icon name="settings" />
        <span>Advanced Settings</span>
        <Icon :name="showAdvancedOptions ? 'chevron-up' : 'chevron-down'" />
      </button>
      
      <Transition name="slide-down">
        <div v-if="showAdvancedOptions" class="advanced-options">
          <div class="option-row">
            <label class="option-label">Auto-preload themes</label>
            <button class="toggle-btn">
              <Icon name="toggle-right" />
            </button>
          </div>
          
          <div class="option-row">
            <label class="option-label">Cache information</label>
            <div class="cache-stats">
              <span v-if="cacheInfo">
                {{ cacheInfo.size }} sounds cached, {{ cacheInfo.loadedThemes.length }} themes loaded
              </span>
            </div>
          </div>
          
          <div class="option-actions">
            <button @click="exportThemeSettings" class="option-btn">
              <Icon name="download" />
              Export Settings
            </button>
            <button @click="importThemeSettings" class="option-btn">
              <Icon name="upload" />
              Import Settings
            </button>
            <button @click="resetToDefaults" class="option-btn danger">
              <Icon name="rotate-ccw" />
              Reset to Defaults
            </button>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useThemeStore } from '@/stores/useTheme'
import { useAudioThemeCommon } from '@/composables/useAudioThemeCommon'
import Icon from '@/components/common/Icon.vue'

interface Props {
  showTestButton?: boolean
  showVolumeControl?: boolean
  showStatus?: boolean
  showCacheButton?: boolean
  showAdvanced?: boolean
  compact?: boolean
  categorized?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  showTestButton: true,
  showVolumeControl: true,
  showStatus: true,
  showCacheButton: false,
  showAdvanced: false,
  compact: false,
  categorized: true
})

const emit = defineEmits<{
  themeChanged: [themeId: string]
  volumeChanged: [volume: number]
  tested: [themeId: string]
}>()

const themeStore = useThemeStore()

const {
  localVolume,
  isTesting,
  themes,
  // eslint-disable-next-line unused-imports/no-unused-vars
  getThemeIcon,
  getThemeIconName,
  selectTheme: baseSelectTheme,
  testCurrentTheme,
  testTheme: baseTestTheme,
  onVolumeChange: baseOnVolumeChange,
  toggleMute,
  setVolumePreset,
  isVolumePresetActive,
  isThemeLoading,
  clearCache,
  preloadTheme,
  exportThemeSettings,
  importThemeSettings,
  resetToDefaults
} = useAudioThemeCommon()

const showAdvancedOptions = ref(false)
const cacheInfo = ref<any>(null)

const volumePresets = [
  { label: 'Low', value: 25 },
  { label: 'Medium', value: 50 },
  { label: 'High', value: 75 },
  { label: 'Max', value: 100 }
]


const displayedThemes = computed(() => {
  const themeList = themes.value
  
  if (props.categorized) {
    // Sort built-in themes first, then by name
    return themeList.sort((a, b) => {
      if (a.isBuiltIn !== b.isBuiltIn) {
        return a.isBuiltIn ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }
  
  return themeList
})

const volumeSliderStyle = computed(() => ({
  '--volume-percentage': `${localVolume.value}%`
}))

const selectTheme = async (themeId: string): Promise<void> => {
  const success = await baseSelectTheme(themeId)
  if (success) {
    emit('themeChanged', themeId)
  }
}

const testTheme = async (themeId: string): Promise<void> => {
  await baseTestTheme(themeId)
  emit('tested', themeId)
}

const onVolumeChange = (): void => {
  baseOnVolumeChange()
  emit('volumeChanged', localVolume.value / 100)
}

const getStatusIcon = (): string => {
  const status = themeStore.systemStatus
  const icons = {
    ready: 'check-circle',
    loading: 'loader',
    preloading: 'loader',
    error: 'alert-circle',
    uninitialized: 'circle'
  }
  return icons[status] || 'circle'
}

const getStatusText = (): string => {
  const status = themeStore.systemStatus
  const currentThemeData = themeStore.getCurrentAudioTheme
  
  const texts = {
    ready: `Ready • ${currentThemeData?.name || 'Unknown'}`,
    loading: 'Loading theme system...',
    preloading: `Preloading ${themeStore.preloadingTheme}...`,
    error: 'System error detected',
    uninitialized: 'Not initialized'
  }
  return texts[status] || 'Unknown status'
}

const updateCacheInfo = (): void => {
  cacheInfo.value = themeStore.getCacheInfo()
}

onMounted(async () => {
  if (!themeStore.isInitialized) {
    await themeStore.initialize()
  }
  
  localVolume.value = Math.round(themeStore.audioVolume * 100)
  updateCacheInfo()
  
  setInterval(updateCacheInfo, 5000)
})

watch(() => themeStore.audioVolume, (newVolume) => {
  localVolume.value = Math.round(newVolume * 100)
})

watch(() => themeStore.currentAudioTheme, () => {
  updateCacheInfo()
})
</script>

<style scoped>
.audio-theme-manager {
  background: var(--background-primary);
  border-radius: 8px;
  padding: 24px;
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
}

/* Header */
.manager-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 20px;
}

.header-content {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.header-icon {
  width: 48px;
  height: 48px;
  background: var(--harmony-primary);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  font-size: 24px;
}

.header-info {
  flex: 1;
}

.header-title {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 4px 0;
  color: var(--text-primary);
}

.header-subtitle {
  color: var(--text-secondary);
  font-size: 14px;
  margin: 0;
  line-height: 1.4;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  width: 40px;
  height: 40px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  border-radius: 10px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.action-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.3);
  color: var(--text-primary);
  transform: translateY(-1px);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Status Bar */
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  margin-bottom: 20px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.status-indicator.ready {
  color: var(--status-online);
}

.status-indicator.loading,
.status-indicator.preloading {
  color: var(--harmony-primary);
}

.status-indicator.error {
  color: var(--error);
}

.cache-info {
  font-size: 12px;
  color: var(--text-secondary);
}

/* Error Banner */
.error-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(245, 101, 101, 0.1);
  border: 1px solid rgba(245, 101, 101, 0.3);
  border-radius: 8px;
  color: var(--error);
  margin-bottom: 20px;
}

.error-close {
  margin-left: auto;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: background 0.2s ease;
}

.error-close:hover {
  background: rgba(245, 101, 101, 0.2);
}

/* Theme Grid */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.theme-card {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
  backdrop-filter: blur(10px);
}

.theme-card:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 255, 255, 0.2);
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
}

.theme-card.active {
  border-color: var(--harmony-primary);
  background: rgba(102, 126, 234, 0.1);
  box-shadow: 0 0 20px rgba(102, 126, 234, 0.3);
}

.theme-card.loading {
  pointer-events: none;
  opacity: 0.7;
}

/* Theme Preview */
.theme-preview {
  position: relative;
  height: 120px;
  background: var(--background-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preview-placeholder {
  font-size: 32px;
  color: var(--text-secondary);
}

.loading-overlay,
.preload-indicator {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  font-size: 24px;
}

.pulsing {
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

/* Theme Info */
.theme-info {
  padding: 16px;
}

.theme-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}

.theme-name {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

.theme-meta {
  display: flex;
  gap: 8px;
  align-items: center;
}

.built-in-badge {
  background: var(--harmony-primary);
  color: var(--text-primary);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.theme-version {
  color: var(--text-secondary);
  font-size: 12px;
}

.theme-description {
  color: #cbd5e0;
  font-size: 14px;
  line-height: 1.5;
  margin: 0 0 16px 0;
}

.theme-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.theme-author {
  color: var(--text-secondary);
  font-size: 12px;
}

.mini-action-btn {
  width: 28px;
  height: 28px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mini-action-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

/* Active Indicator */
.active-indicator {
  position: absolute;
  top: 12px;
  right: 12px;
  color: var(--harmony-primary);
  background: var(--text-primary);
  border-radius: 50%;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

/* Loading Progress */
.loading-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.1);
}

.progress-bar {
  height: 100%;
  background: var(--harmony-primary);
  transition: width 0.3s ease;
}

/* Volume Section */
.volume-section {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 12px;
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.volume-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.volume-label {
  flex: 1;
  font-weight: 600;
  color: var(--text-primary);
}

.volume-value {
  color: var(--harmony-primary);
  font-weight: 600;
  font-size: 14px;
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 16px;
}

.volume-mute-btn {
  width: 36px;
  height: 36px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.volume-mute-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.volume-mute-btn.muted {
  color: var(--error);
  border-color: var(--error);
}

.volume-slider-container {
  flex: 1;
  position: relative;
  height: 36px;
  display: flex;
  align-items: center;
}

.volume-slider {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: transparent;
  outline: none;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  z-index: 1;
}

.volume-track {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 6px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  transform: translateY(-50%);
  pointer-events: none;
}

.volume-fill {
  height: 100%;
  background: var(--harmony-primary);
  border-radius: 3px;
  transition: width 0.2s ease;
}

.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--harmony-primary);
  cursor: pointer;
  border: 2px solid #ffffff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  transition: all 0.2s ease;
}

.volume-slider::-webkit-slider-thumb:hover {
  transform: scale(1.1);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

.volume-presets {
  display: flex;
  gap: 6px;
}

.preset-btn {
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
  font-weight: 500;
}

.preset-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.preset-btn.active {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}

/* Advanced Section */
.advanced-section {
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding-top: 20px;
}

.advanced-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.advanced-toggle:hover {
  background: rgba(255, 255, 255, 0.1);
}

.advanced-options {
  margin-top: 16px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.option-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.option-row:last-child {
  border-bottom: none;
}

.option-label {
  color: var(--text-primary);
  font-weight: 500;
}

.cache-stats {
  color: var(--text-secondary);
  font-size: 14px;
}

.option-actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.option-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 14px;
}

.option-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.option-btn.danger {
  border-color: rgba(245, 101, 101, 0.3);
  color: var(--error);
}

.option-btn.danger:hover {
  background: rgba(245, 101, 101, 0.1);
  border-color: var(--error);
}

/* Transitions */
.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.3s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* Compact Mode */
.audio-theme-manager.compact {
  padding: 16px;
}

.audio-theme-manager.compact .theme-grid {
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 12px;
}

.audio-theme-manager.compact .theme-preview {
  height: 80px;
}

.audio-theme-manager.compact .theme-info {
  padding: 12px;
}

.audio-theme-manager.compact .header-title {
  font-size: 20px;
}

/* Responsive */
@media (max-width: 768px) {
  .theme-grid {
    grid-template-columns: 1fr;
  }
  
  .volume-control {
    flex-direction: column;
    gap: 12px;
  }
  
  .volume-presets {
    align-self: stretch;
    justify-content: space-between;
  }
  
  .option-actions {
    flex-direction: column;
  }
  
  .option-btn {
    justify-content: center;
  }
}
</style>
