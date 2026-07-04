<template>
  <div class="audio-theme-showcase">
    <div class="showcase-header">
      <h1>🎵 Audio Theme System Showcase</h1>
      <p>Professional audio theme management for Harmony</p>
    </div>

    <div class="showcase-grid">
      <!-- Main Theme Manager -->
      <div class="showcase-section main">
        <h2>Audio Theme Manager</h2>
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
        <h2>Compact Version</h2>
        <AudioThemeManager 
          compact
          :show-advanced="false"
          :show-status="false"
        />
      </div>

      <!-- Quick Actions -->
      <div class="showcase-section">
        <h2>Quick Test Actions</h2>
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
        <h2>System Information</h2>
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
            <span>Current Theme:</span>
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
        <h2>Developer Tools</h2>
        <div class="dev-tools">
          <button @click="exportSettings" class="dev-btn">
            <Icon name="download" />
            Export Settings
          </button>
          <button @click="clearCache" class="dev-btn">
            <Icon name="trash-2" />
            Clear Cache
          </button>
          <button @click="resetSystem" class="dev-btn danger">
            <Icon name="rotate-ccw" />
            Reset System
          </button>
        </div>

        <div v-if="showDebugInfo" class="debug-info">
          <h4>Debug Information</h4>
          <pre>{{ debugInfo }}</pre>
        </div>
        
        <button @click="showDebugInfo = !showDebugInfo" class="debug-toggle">
          <Icon :name="showDebugInfo ? 'eye-off' : 'eye'" />
          {{ showDebugInfo ? 'Hide' : 'Show' }} Debug Info
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
          <Icon :name="getToastIcon(toast.type)" />
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
import { useThemeStore } from '@/stores/useTheme'
import type { AudioAction } from '@/types'
import AudioThemeManager from '@/components/settings/AudioThemeManager.vue'
import Icon from '@/components/common/Icon.vue'

// STATE

const themeStore = useThemeStore()

const toasts = ref<Array<{ id: string, type: string, message: string }>>([])
const showDebugInfo = ref(false)
const cacheInfo = ref<any>(null)

// Test actions for demonstration
const testActions = [
  { id: 'mention', label: 'Mention', icon: 'at-sign', category: 'notification' },
  { id: 'dm', label: 'Direct Message', icon: 'message-circle', category: 'notification' },
  { id: 'reaction', label: 'Reaction', icon: 'heart', category: 'notification' },
  { id: 'voice_connect', label: 'Voice Connect', icon: 'phone', category: 'voice' },
  { id: 'voice_disconnect', label: 'Voice Disconnect', icon: 'phone-off', category: 'voice' },
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
    showToast('success', `Tested ${actionId} successfully`)
  } catch (error) {
    debug.error('Test failed:', error)
    showToast('error', `Failed to test ${actionId}`)
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
    showToast('success', 'Settings exported successfully')
  } catch (error) {
    showToast('error', 'Failed to export settings')
  }
}

const clearCache = (): void => {
  themeStore.clearAudioCache()
  updateCacheInfo()
  showToast('success', 'Audio cache cleared')
}

const resetSystem = async (): Promise<void> => {
  if (confirm('This will reset all audio settings to defaults. Continue?')) {
    try {
      await themeStore.resetToDefaults()
      updateCacheInfo()
      showToast('success', 'System reset to defaults')
    } catch (error) {
      showToast('error', 'Failed to reset system')
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
    showToast('error', 'Failed to initialize audio system')
  }
})
</script>

<style scoped>
.audio-theme-showcase {
  min-height: 100vh;
  background: linear-gradient(135deg, #0f1419 0%, #1a202c 50%, #2d3748 100%);
  color: var(--text-primary);
  padding: 32px;
}

.showcase-header {
  text-align: center;
  margin-bottom: 48px;
}

.showcase-header h1 {
  font-size: 48px;
  font-weight: 800;
  margin: 0 0 16px 0;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.showcase-header p {
  font-size: 20px;
  color: #a0aec0;
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
  background: rgba(255, 255, 255, 0.05);
  border-radius: 16px;
  padding: 24px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
}

.showcase-section.main {
  grid-column: 1 / -1;
}

.showcase-section h2 {
  font-size: 24px;
  font-weight: 700;
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
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 14px;
  font-weight: 500;
}

.test-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
}

.test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.test-btn.notification {
  border-color: rgba(102, 126, 234, 0.3);
}

.test-btn.voice {
  border-color: rgba(72, 187, 120, 0.3);
}

.test-btn.ui {
  border-color: rgba(237, 137, 54, 0.3);
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
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.info-item > span:first-of-type {
  flex: 1;
  font-weight: 500;
  color: #a0aec0;
}

.status-badge {
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.status-badge.ready {
  background: rgba(72, 187, 120, 0.2);
  color: #68d391;
  border: 1px solid rgba(72, 187, 120, 0.3);
}

.status-badge.loading,
.status-badge.preloading {
  background: rgba(66, 153, 225, 0.2);
  color: #63b3ed;
  border: 1px solid rgba(66, 153, 225, 0.3);
}

.status-badge.error {
  background: rgba(245, 101, 101, 0.2);
  color: #fc8181;
  border: 1px solid rgba(245, 101, 101, 0.3);
}

.theme-name,
.volume-display,
.cache-display {
  color: #667eea;
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
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 14px;
  font-weight: 500;
}

.dev-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  transform: translateY(-1px);
}

.dev-btn.danger {
  border-color: rgba(245, 101, 101, 0.3);
  color: #fc8181;
}

.dev-btn.danger:hover {
  background: rgba(245, 101, 101, 0.1);
}

.debug-info {
  background: rgba(0, 0, 0, 0.4);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.debug-info h4 {
  margin: 0 0 12px 0;
  color: var(--text-primary);
}

.debug-info pre {
  color: #a0aec0;
  font-size: 12px;
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
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #a0aec0;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
}

.debug-toggle:hover {
  background: rgba(255, 255, 255, 0.1);
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
  background: rgba(0, 0, 0, 0.9);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.toast.success {
  border-color: rgba(72, 187, 120, 0.3);
  color: #68d391;
}

.toast.error {
  border-color: rgba(245, 101, 101, 0.3);
  color: #fc8181;
}

.toast.info {
  border-color: rgba(66, 153, 225, 0.3);
  color: #63b3ed;
}

.toast-close {
  margin-left: auto;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: background 0.2s ease;
}

.toast-close:hover {
  background: rgba(255, 255, 255, 0.1);
}

/* Toast Transitions */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%) scale(0.8);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(100%) scale(0.8);
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
    font-size: 36px;
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
