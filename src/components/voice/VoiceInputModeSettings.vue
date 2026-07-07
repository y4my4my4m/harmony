<template>
  <div class="input-mode-settings">
    <div class="input-mode-options">
      <label
        class="input-mode-option"
        :class="{ active: inputMode === 'voice_activity' }"
        @click="setInputMode('voice_activity')"
      >
        <div class="radio-custom" :class="{ checked: inputMode === 'voice_activity' }">
          <div class="radio-inner"></div>
        </div>
        <div class="mode-content">
          <span class="mode-title">Voice Activity</span>
          <small class="mode-description">Automatically transmit when you speak</small>
        </div>
      </label>

      <label
        class="input-mode-option"
        :class="{ active: inputMode === 'push_to_talk' }"
        @click="setInputMode('push_to_talk')"
      >
        <div class="radio-custom" :class="{ checked: inputMode === 'push_to_talk' }">
          <div class="radio-inner"></div>
        </div>
        <div class="mode-content">
          <span class="mode-title">Push to Talk</span>
          <small class="mode-description">Hold a key to transmit</small>
        </div>
      </label>
    </div>

    <div v-if="inputMode === 'push_to_talk'" class="ptt-settings">
      <div class="setting-group">
        <label class="setting-label">Push to Talk Shortcut</label>
        <button
          class="keybind-button"
          :class="{ recording: isRecordingKeybind }"
          @click="toggleRecording"
        >
          <Icon name="keyboard" />
          <span v-if="isRecordingKeybind">Press any key...</span>
          <span v-else>{{ pttKeyDisplay }}</span>
        </button>
        <small class="setting-hint">Click, then press a key. Works while Harmony is focused.</small>
      </div>

      <div class="setting-group">
        <label class="setting-label">
          Release Delay
          <span class="setting-value">{{ releaseDelay }}ms</span>
        </label>
        <input
          type="range"
          v-model.number="localReleaseDelay"
          min="0"
          max="500"
          step="50"
          class="setting-slider"
          @input="ptt.setReleaseDelay(localReleaseDelay)"
        />
        <small class="setting-hint">Delay before muting after release (prevents cutting off words)</small>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { usePushToTalk } from '@/composables/usePushToTalk';
import Icon from '@/components/common/Icon.vue';

const emit = defineEmits<{ 'input-mode-change': [mode: 'voice_activity' | 'push_to_talk'] }>();

const ptt = usePushToTalk();
const inputMode = ptt.inputMode;
const pttKeyDisplay = ptt.pttKeyDisplay;
const releaseDelay = ptt.releaseDelay;
const isRecordingKeybind = ptt.isRecordingKeybind;
const localReleaseDelay = ref(ptt.releaseDelay.value);

function setInputMode(mode: 'voice_activity' | 'push_to_talk') {
  ptt.setInputMode(mode);
  emit('input-mode-change', mode);
}

function onKey(e: KeyboardEvent) {
  if (ptt.recordKeybind(e)) {
    e.preventDefault();
    e.stopPropagation();
    stopRecording();
  }
}

function onMouse(e: MouseEvent) {
  if (ptt.recordMouseButton(e)) {
    e.preventDefault();
    e.stopPropagation();
    stopRecording();
  }
}

function stopRecording() {
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('mousedown', onMouse, true);
}

function toggleRecording() {
  if (isRecordingKeybind.value) {
    ptt.cancelRecordingKeybind();
    stopRecording();
  } else {
    ptt.startRecordingKeybind();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
  }
}

onUnmounted(stopRecording);
</script>

<style scoped>
.input-mode-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
}
.input-mode-option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  background: var(--background-tertiary);
  border: 2px solid var(--border-primary);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.input-mode-option:hover {
  background: var(--background-secondary);
  border-color: var(--border-hover);
}
.input-mode-option.active {
  background: var(--harmony-primary-light);
  border-color: var(--harmony-primary);
}
.radio-custom {
  width: 20px;
  height: 20px;
  border: 2px solid var(--text-muted);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
  transition: all 0.2s ease;
}
.radio-custom.checked {
  border-color: var(--harmony-primary);
}
.radio-inner {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: transparent;
  transition: all 0.2s ease;
}
.radio-custom.checked .radio-inner {
  background: var(--harmony-primary);
}
.mode-content {
  flex: 1;
}
.mode-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.mode-description {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}
.ptt-settings {
  padding-top: 16px;
  border-top: 1px solid var(--border-primary);
}
.setting-group {
  margin-bottom: 20px;
}
.setting-group:last-child {
  margin-bottom: 0;
}
.setting-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.setting-value {
  color: var(--harmony-primary);
  font-weight: 600;
}
.keybind-button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}
.keybind-button:hover {
  background: var(--background-secondary);
  border-color: var(--border-hover);
}
.keybind-button.recording {
  background: var(--harmony-primary-light);
  border-color: var(--harmony-primary);
  color: var(--harmony-primary);
}
.setting-slider {
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}
.setting-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  background: var(--harmony-primary);
  border-radius: 50%;
  cursor: pointer;
}
.setting-hint {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  opacity: 0.8;
}
</style>
