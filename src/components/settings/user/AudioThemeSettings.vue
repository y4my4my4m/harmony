<template>
  <div class="audio-theme-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.audio.title') }}</h2>
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
      <h3 class="section-title">{{ $t('common.preview') }}</h3>
      <p class="section-description">Test how different actions will sound with your current theme</p>
      <br>
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

    <!-- Import / Export audio theme packs -->
    <div class="settings-section import-export-section">
      <h3 class="section-title">Import & Export Theme Packs</h3>
      <p class="section-description">Export a full audio theme (sounds + metadata) to share or backup. Import a pack to add it as a custom theme.</p>
      <div class="import-export-actions">
        <button @click="exportThemePack" class="import-export-btn" :disabled="!themeStore.isReady || isExportingPack">
          <Icon :name="isExportingPack ? 'loader' : 'download'" :class="{ spinning: isExportingPack }" />
          {{ isExportingPack ? 'Exporting...' : 'Export Pack' }}
        </button>
        <button @click="importThemePack" class="import-export-btn" :disabled="!themeStore.isReady">
          <Icon name="upload" />
          Import Pack
        </button>
      </div>
    </div>

    <!-- Advanced Settings -->
    <div class="settings-section advanced-section" v-if="showAdvanced">
      <h3 class="section-title">{{ $t('settings.advanced.title') }}</h3>
      
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
          <h4 class="setting-label">{{ $t('common.clear') }} Audio Cache</h4>
          <p class="setting-description">Clear cached audio files to force reload of all sounds</p>
        </div>
        <div class="setting-control">
          <button @click="clearCache" class="clear-cache-btn" :disabled="isLoading">
            <Icon name="trash-2" />
            {{ $t('common.clear') }}
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
          <h4 class="setting-label">{{ $t('common.reset') }}</h4>
          <p class="setting-description">Reset all audio settings to defaults</p>
        </div>
        <div class="setting-control">
          <button @click="resetSystem" class="btn btn-danger" :disabled="isLoading">
            <Icon name="rotate-ccw" />
            {{ $t('common.reset') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Toggle Advanced -->
    <div class="advanced-toggle">
      <button @click="showAdvanced = !showAdvanced" class="toggle-btn">
        <Icon :name="showAdvanced ? 'chevron-up' : 'chevron-down'" />
        {{ showAdvanced ? 'Hide' : 'Show' }} {{ $t('settings.advanced.title') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useThemeStore } from '@/stores/useTheme'
import { useNotificationStore } from '@/stores/useNotification'
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
const isExportingPack = ref(false)

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
    debug.error('Failed to test sound:', error)
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
    debug.error('Failed to clear cache:', error)
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
    await themeStore.resetToDefaults()
    notificationStore.showToast(
      'ui_success' as any,
      'System Reset',
      'Audio system reset successfully',
      2000
    )
  } catch (error) {
    debug.error('Failed to reset system:', error)
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

const PACK_MAX_BYTES = 10 * 1024 * 1024 // 10MB

const exportThemePack = async (): Promise<void> => {
  if (!themeStore.isReady) return
  try {
    isExportingPack.value = true
    const blob = await themeStore.exportThemePack(themeStore.currentAudioTheme)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const themeName = themeStore.getCurrentAudioTheme?.name ?? themeStore.currentAudioTheme
    a.download = `harmony-audio-pack-${String(themeName).replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    URL.revokeObjectURL(url)
    notificationStore.showToast('ui_success' as any, 'Pack exported', 'Audio theme pack downloaded as ZIP', 2000)
  } catch (error) {
    debug.error('Failed to export pack:', error)
    notificationStore.showToast('ui_error' as any, 'Export failed', error instanceof Error ? error.message : 'Could not export theme pack', 3000)
  } finally {
    isExportingPack.value = false
  }
}

const importThemePack = (): void => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.zip,application/zip'
  input.onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    if (file.size > PACK_MAX_BYTES) {
      notificationStore.showToast('ui_error' as any, 'File too large', 'Pack must be under 10MB', 3000)
      return
    }
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const arrayBuffer = ev.target?.result as ArrayBuffer
        const theme = await themeStore.importThemePack(arrayBuffer)
        notificationStore.showToast('ui_success' as any, 'Pack imported', `${theme.name} added as custom theme`, 2000)
      } catch (err) {
        debug.error('Failed to import pack:', err)
        notificationStore.showToast('ui_error' as any, 'Import failed', err instanceof Error ? err.message : 'Invalid audio pack format', 3000)
      }
    }
    reader.readAsArrayBuffer(file)
  }
  input.click()
}

// =============================================================================
// LIFECYCLE
// =============================================================================

onMounted(async () => {
  try {
    await themeStore.initialize()
  } catch (error) {
    debug.error('Failed to initialize audio theme store:', error)
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
  max-width: 720px;
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

.settings-section {
  background-color: var(--h-chat);
  border-radius: 8px;
  padding: 24px;
  margin-bottom: 32px;
  border: 1px solid var(--h-chat-light);
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #ffffff);
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
  color: var(--text-primary);
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
  color: var(--text-primary);
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
  color: var(--text-secondary);
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
  color: var(--text-primary);
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
  background: rgba(14, 165, 233, 0.05);
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
  color: var(--text-primary);
}

.theme-version {
  font-size: 12px;
  color: var(--text-secondary);
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
  color: var(--text-secondary);
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
  color: var(--text-muted);
}

.test-theme-btn {
  background: transparent;
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  padding: 6px;
  color: var(--text-secondary);
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
  color: var(--text-secondary);
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
  color: var(--text-primary);
  /* background: rgba(14, 165, 233, 0.1); */
  background: color-mix(in srgb, var(--h-brand) 10%, transparent);
}

.sound-test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Import / Export */
.import-export-section .section-description {
  margin-bottom: 16px;
}

.import-export-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.import-export-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: transparent;
  border: 1px solid var(--h-chat-light);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.import-export-btn:hover:not(:disabled) {
  border-color: var(--h-brand);
  color: var(--text-primary);
  background: color-mix(in srgb, var(--h-brand) 10%, transparent);
}

.import-export-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Advanced Settings */
.advanced-section {
  border: 1px dashed var(--h-chat-light);
  background: color-mix(in srgb, var(--h-chat-light) 30%, transparent);
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
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.setting-description {
  font-size: 12px;
  color: var(--text-secondary);
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
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.toggle-btn:hover {
  border-color: var(--h-brand);
  color: var(--text-primary);
}

/* Import/Export section */
.import-export-section .section-description {
  margin-bottom: 16px;
}

.import-export-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.import-export-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  background: transparent;
  border: 1px solid var(--h-chat-light);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.import-export-btn:hover:not(:disabled) {
  border-color: var(--h-brand);
  color: var(--text-primary);
  background: rgba(14, 165, 233, 0.08);
}

.import-export-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
