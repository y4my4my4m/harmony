<template>
  <div class="audio-theme-showcase">
    <div class="showcase-header">
      <h1>Audio themes</h1>
      <p>Preview and test notification and interface sounds.</p>
    </div>

    <div class="showcase-grid">
      <!-- Main Theme Manager -->
      <div class="showcase-section main">
        <h2>Audio theme manager</h2>
        <AudioThemeManager 
          :show-test-button="true"
          :show-volume-control="true"
          :show-status="true"
          :show-cache-button="true"
          :show-advanced="true"
          @theme-changed="onThemeChanged"
          @volume-changed="onVolumeChanged"
          @tested="onThemeTested"
        />
      </div>

      <!-- Compact Version -->
      <div class="showcase-section">
        <h2>Compact version</h2>
        <AudioThemeManager 
          compact
          :show-advanced="false"
          :show-status="false"
        />
      </div>

      <!-- Quick Actions -->
      <div class="showcase-section">
        <h2>Quick test actions</h2>
        <div class="test-actions">
          <button 
            v-for="action in testActions"
            :key="action.id"
            @click="testAction(action.id)"
            :class="['test-btn', action.category]"
            :disabled="!themeStore.isReady"
          >
            <Icon :name="action.icon" />
            <span>{{ action.label }}</span>
          </button>
        </div>
      </div>

      <!-- System Status -->
      <div class="showcase-section">
        <h2>System information</h2>
        <div class="system-info">
          <div class="info-item">
            <Icon name="info" />
            <span>Status:</span>
            <span :class="['status-badge', themeStore.systemStatus]">
              {{ themeStore.systemStatus }}
            </span>
          </div>
          <div class="info-item">
            <Icon name="music" />
            <span>Current theme:</span>
            <span class="theme-name">{{ currentTheme?.name || 'None' }}</span>
          </div>
          <div class="info-item">
            <Icon name="volume-2" />
            <span>Volume:</span>
            <span class="volume-display">{{ Math.round(themeStore.audioVolume * 100) }}%</span>
          </div>
          <div v-if="cacheInfo" class="info-item">
            <Icon name="database" />
            <span>Cache:</span>
            <span class="cache-display">
              {{ cacheInfo.size }}/{{ cacheInfo.maxSize }} sounds loaded
            </span>
          </div>
        </div>
      </div>

      <!-- Developer Tools -->
      <div class="showcase-section">
        <h2>Developer tools</h2>
        <div class="dev-tools">
          <button @click="exportSettings" class="dev-btn">
            <Icon name="download" />
            Export settings
          </button>
          <button @click="clearCache" class="dev-btn">
            <Icon name="trash-2" />
            Clear cache
          </button>
          <button @click="resetSystem" class="dev-btn danger">
            <Icon name="rotate-ccw" />
            Reset system
          </button>
        </div>

        <div v-if="showDebugInfo" class="debug-info">
          <h4>Debug information</h4>
          <pre>{{ debugInfo }}</pre>
        </div>
        
        <button @click="showDebugInfo = !showDebugInfo" class="debug-toggle">
          <Icon :name="showDebugInfo ? 'eye-off' : 'eye'" />
          {{ showDebugInfo ? 'Hide' : 'Show' }} debug info
        </button>
      </div>
    </div>

    <!-- Toast Notifications -->
    <div class="toast-container">
      <TransitionGroup name="toast" tag="div">
        <div 
          v-for="toast in toasts" 
          :key="toast.id"
          :class="['toast', toast.type]"
        >
          <Icon :name="getToastIcon(toast.type)" class="toast-icon" />
          <span>{{ toast.message }}</span>
          <button @click="removeToast(toast.id)" class="toast-close">
            <Icon name="x" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useThemeStore } from '@/stores/useTheme'
import type { AudioAction } from '@/types'
import AudioThemeManager from '@/components/settings/AudioThemeManager.vue'
import Icon from '@/components/common/Icon.vue'

// STATE

const { confirm } = useConfirmDialog()
const themeStore = useThemeStore()

const toasts = ref<Array<{ id: string, type: string, message: string }>>([])
const showDebugInfo = ref(false)
const cacheInfo = ref<any>(null)

// Test actions for demonstration
const testActions = [
  { id: 'mention', label: 'Mention', icon: 'at-sign', category: 'notification' },
  { id: 'dm', label: 'Direct message', icon: 'message-circle', category: 'notification' },
  { id: 'reaction', label: 'Reaction', icon: 'heart', category: 'notification' },
  { id: 'voice_connect', label: 'Voice connect', icon: 'phone', category: 'voice' },
  { id: 'voice_disconnect', label: 'Voice disconnect', icon: 'phone-off', category: 'voice' },
  { id: 'ui_success', label: 'Success', icon: 'check-circle', category: 'ui' },
  { id: 'ui_error', label: 'Error', icon: 'alert-circle', category: 'ui' },
  { id: 'ui_click', label: 'Click', icon: 'mouse-pointer', category: 'ui' }
] as const

// COMPUTED

const currentTheme = computed(() => themeStore.getCurrentAudioTheme)

const debugInfo = computed(() => ({
  systemStatus: themeStore.systemStatus,
  currentTheme: themeStore.currentAudioTheme,
  volume: themeStore.audioVolume,
  isInitialized: themeStore.isInitialized,
  isLoading: themeStore.isLoading,
  isPreloading: themeStore.isPreloading,
  lastError: themeStore.lastError,
  cacheInfo: cacheInfo.value,
  availableThemes: themeStore.audioThemes.map(t => ({ id: t.id, name: t.name }))
}))

// METHODS

const testAction = async (actionId: string): Promise<void> => {
  try {
    await themeStore.testAudio(actionId as AudioAction)
    showToast('success', `Played ${actionId}`)
  } catch (error) {
    debug.error('Test failed:', error)
    showToast('error', `Couldn't play ${actionId}`)
  }
}

const onThemeChanged = (themeId: string): void => {
  showToast('success', `Switched to ${themeId} theme`)
  updateCacheInfo()
}

const onVolumeChanged = (_volume: number): void => {
  // showToast('info', `Volume set to ${Math.round(volume * 100)}%`)
}

const onThemeTested = (_themeId: string): void => {
  // showToast('info', `Tested ${themeId} theme`)
}

const exportSettings = (): void => {
  try {
    const settings = themeStore.exportPreferences()
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `harmony-audio-settings-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast('success', 'Settings exported')
  } catch (error) {
    showToast('error', "Couldn't export settings")
  }
}

const clearCache = (): void => {
  themeStore.clearAudioCache()
  updateCacheInfo()
  showToast('success', 'Audio cache cleared')
}

const resetSystem = async (): Promise<void> => {
  const ok = await confirm({
    title: 'Reset audio',
    message: 'This will reset all audio settings to defaults. Continue?',
    confirmButtonText: 'Reset',
    dangerAction: true,
  })
  if (ok) {
    try {
      await themeStore.resetToDefaults()
      updateCacheInfo()
      showToast('success', 'System reset to defaults')
    } catch (error) {
      showToast('error', "Couldn't reset audio settings")
    }
  }
}

const updateCacheInfo = (): void => {
  try {
    cacheInfo.value = themeStore.getCacheInfo()
  } catch (error) {
    debug.warn('Failed to get cache info:', error)
  }
}

// Toast system
const showToast = (type: string, message: string): void => {
  const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  toasts.value.push({ id, type, message })
  
  setTimeout(() => {
    removeToast(id)
  }, 4000)
}

const removeToast = (id: string): void => {
  const index = toasts.value.findIndex(t => t.id === id)
  if (index > -1) {
    toasts.value.splice(index, 1)
  }
}

const getToastIcon = (type: string): string => {
  const icons: Record<string, string> = {
    success: 'check-circle',
    error: 'alert-circle',
    info: 'info',
    warning: 'alert-triangle'
  }
  return icons[type] || 'info'
}

// LIFECYCLE

onMounted(async () => {
  try {
    if (!themeStore.isInitialized) {
      await themeStore.initialize()
    }
    updateCacheInfo()
    showToast('success', 'Audio theme system initialized')
  } catch (error) {
    debug.error('Failed to initialize:', error)
    showToast('error', "Couldn't start the audio system")
  }
})
</script>

<style scoped>
.audio-theme-showcase {
  min-height: 100vh;
  background: var(--background-primary);
  color: var(--text-primary);
  padding: 32px;
}

.showcase-header {
  text-align: center;
  margin-bottom: 48px;
}

.showcase-header h1 {
  font-size: var(--font-size-3xl);
  font-weight: 700;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.showcase-header p {
  font-size: var(--font-size-base);
  color: var(--text-secondary);
  margin: 0;
}

.showcase-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 32px;
  max-width: 1400px;
  margin: 0 auto;
}

.showcase-section {
  background: var(--background-secondary);
  border-radius: var(--radius-lg);
  padding: 24px;
  border: 1px solid var(--border-primary);
}

.showcase-section.main {
  grid-column: 1 / -1;
}

.showcase-section h2 {
  font-size: var(--font-size-xl);
  font-weight: 600;
  margin: 0 0 20px 0;
  color: var(--text-primary);
}

/* Test Actions */
.test-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.test-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease;
  font-size: var(--font-size-sm);
  font-weight: 500;
}

.test-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
}

.test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* System Info */
.system-info {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.info-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
}

.info-item > span:first-of-type {
  flex: 1;
  font-weight: 500;
  color: var(--text-secondary);
}

.status-badge {
  padding: 4px 12px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.status-badge.ready {
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
}

.status-badge.loading,
.status-badge.preloading {
  background: var(--harmony-primary-alpha);
  color: var(--harmony-primary);
  border: 1px solid var(--harmony-primary-alpha-strong);
}

.status-badge.error {
  background: color-mix(in srgb, var(--error) 15%, transparent);
  color: var(--error);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
}

.theme-name,
.volume-display,
.cache-display {
  color: var(--text-primary);
  font-weight: 600;
}

/* Developer Tools */
.dev-tools {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.dev-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color 0.2s ease;
  font-size: var(--font-size-sm);
  font-weight: 500;
}

.dev-btn:hover {
  background: var(--background-modifier-hover);
}

.dev-btn.danger {
  border-color: color-mix(in srgb, var(--error) 30%, transparent);
  color: var(--error);
}

.dev-btn.danger:hover {
  background: color-mix(in srgb, var(--error) 10%, transparent);
}

.debug-info {
  background: var(--background-tertiary);
  border-radius: var(--radius-md);
  padding: 16px;
  margin-bottom: 16px;
  border: 1px solid var(--border-primary);
}

.debug-info h4 {
  margin: 0 0 12px 0;
  color: var(--text-primary);
}

.debug-info pre {
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  margin: 0;
  white-space: pre-wrap;
  overflow-x: auto;
}

.debug-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.2s ease, color 0.2s ease;
  font-size: var(--font-size-xs);
}

.debug-toggle:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

/* Toasts */
.toast-container {
  position: fixed;
  top: 24px;
  right: 24px;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 400px;
}

.toast {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--background-floating);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-large);
}

.toast.success .toast-icon {
  color: var(--success);
}

.toast.error .toast-icon {
  color: var(--error);
}

.toast.info .toast-icon {
  color: var(--info);
}

.toast-close {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
  transition: background-color 0.2s ease;
}

.toast-close:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

/* Toast Transitions */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}

/* Responsive */
@media (max-width: 1024px) {
  .showcase-grid {
    grid-template-columns: 1fr;
  }
  
  .showcase-section.main {
    grid-column: 1;
  }
}

@media (max-width: 768px) {
  .audio-theme-showcase {
    padding: 16px;
  }
  
  .showcase-header h1 {
    font-size: var(--font-size-2xl);
  }
  
  .test-actions {
    grid-template-columns: 1fr;
  }
  
  .dev-tools {
    flex-direction: column;
  }
  
  .toast-container {
    left: 16px;
    right: 16px;
    max-width: none;
  }
}
</style>
