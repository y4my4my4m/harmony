<template>
  <div class="audio-theme-picker">
    <div class="picker-header">
      <label class="picker-label">Audio Theme</label>
      <button 
        v-if="showTestButton"
        @click="testCurrentTheme" 
        class="test-button"
        :disabled="isThemeLoading()"
      >
        <Icon name="volume-2" />
      </button>
    </div>
    
    <div class="theme-selector">        <div 
          v-for="theme in themes"
          :key="theme.id"
          :class="[
            'theme-option',
            { 
              'active': theme.id === currentTheme,
              'loading': isThemeLoading(theme.id)
            }
          ]"
          @click="selectTheme(theme.id)"
        >
          <div class="theme-icon">
            {{ getThemeIcon(theme.id) }}
          </div>
          <div class="theme-info">
            <span class="theme-name">{{ theme.name }}</span>
            <span class="theme-description">{{ theme.description }}</span>
          </div>
          <div class="theme-status">
            <Icon 
              v-if="theme.id === currentTheme" 
              name="check" 
              class="check-icon"
            />
            <div 
              v-else-if="isThemeLoading(theme.id)"
              class="loading-dot"
            />
          </div>
        </div>
    </div>
    
    <div v-if="showVolumeControl" class="volume-section">
      <div class="volume-control">
        <Icon name="volume-1" class="volume-icon-small" />
        <input
          v-model.number="localVolume"
          @input="onVolumeChange"
          type="range"
          min="0"
          max="100"
          step="5"
          class="volume-slider-small"
        />
        <span class="volume-text">{{ Math.round(localVolume) }}%</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAudioThemeCommon } from '@/composables/useAudioThemeCommon'
import Icon from '@/components/common/Icon.vue'

interface Props {
  showTestButton?: boolean
  showVolumeControl?: boolean
  compact?: boolean
}

withDefaults(defineProps<Props>(), {
  showTestButton: true,
  showVolumeControl: true,
  compact: false
})

// Use shared composable
const {
  localVolume,
  themes,
  currentTheme,
  getThemeIcon,
  selectTheme,
  testCurrentTheme,
  onVolumeChange,
  isThemeLoading
} = useAudioThemeCommon()
</script>

<style scoped>
.audio-theme-picker {
  background: var(--background-senary);
  border-radius: 8px;
  padding: 16px;
}

.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.picker-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.test-button {
  background: transparent;
  border: 1px solid var(--background-quaternary);
  border-radius: 4px;
  padding: 4px 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.test-button:hover:not(:disabled) {
  border-color: var(--h-brand);
  color: var(--h-brand);
}

.test-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.theme-selector {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.theme-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--background-secondary);
  border: 1px solid var(--background-quaternary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.theme-option:hover {
  border-color: var(--h-brand);
  background: color-mix(in srgb, var(--h-brand) 5%, transparent);
}

.theme-option.active {
  border-color: var(--h-brand);
  background: color-mix(in srgb, var(--h-brand) 10%, transparent);
}

.theme-option.loading {
  opacity: 0.7;
  pointer-events: none;
}

.theme-icon {
  font-size: 16px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background-quaternary);
  border-radius: 4px;
  flex-shrink: 0;
}

.theme-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.theme-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.theme-description {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.3;
}

.theme-status {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.check-icon {
  color: var(--h-brand);
  width: 14px;
  height: 14px;
}

.loading-dot {
  width: 12px;
  height: 12px;
  background: var(--h-brand);
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.volume-section {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--background-quaternary);
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.volume-icon-small {
  color: var(--text-secondary);
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.volume-slider-small {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--background-quaternary);
  outline: none;
  cursor: pointer;
}

.volume-slider-small::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--h-brand);
  cursor: pointer;
  border: 1px solid #ffffff;
}

.volume-slider-small::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--h-brand);
  cursor: pointer;
  border: 1px solid #ffffff;
}

.volume-text {
  font-size: 11px;
  color: var(--text-secondary);
  min-width: 28px;
  text-align: right;
  flex-shrink: 0;
}

/* Compact mode */
.audio-theme-picker.compact {
  padding: 12px;
}

.audio-theme-picker.compact .theme-option {
  padding: 8px;
}

.audio-theme-picker.compact .theme-icon {
  font-size: 14px;
  width: 20px;
  height: 20px;
}

.audio-theme-picker.compact .theme-name {
  font-size: 12px;
}

.audio-theme-picker.compact .theme-description {
  font-size: 10px;
}
</style>
