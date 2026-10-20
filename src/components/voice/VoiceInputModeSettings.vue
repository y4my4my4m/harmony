<template>
  <div class="input-mode-settings">
    <fieldset class="input-mode-options">
      <legend class="sr-only">{{ t('settings.voice.inputMode') }}</legend>
      <label
        class="input-mode-option"
        :class="{ active: inputMode === 'voice_activity' }"
      >
        <input
          type="radio"
          class="input-mode-radio"
          :name="groupName"
          value="voice_activity"
          :checked="inputMode === 'voice_activity'"
          :aria-describedby="`${idBase}-va-desc`"
          data-testid="input-mode-voice-activity"
          @change="setInputMode('voice_activity')"
        />
        <span class="radio-custom" :class="{ checked: inputMode === 'voice_activity' }" aria-hidden="true">
          <span class="radio-inner"></span>
        </span>
        <span class="mode-content">
          <span class="mode-title">{{ t('settings.voice.voiceActivity') }}</span>
          <small :id="`${idBase}-va-desc`" class="mode-description">{{ t('settings.voice.voiceActivityDesc') }}</small>
        </span>
      </label>

      <label
        class="input-mode-option"
        :class="{ active: inputMode === 'push_to_talk' }"
      >
        <input
          type="radio"
          class="input-mode-radio"
          :name="groupName"
          value="push_to_talk"
          :checked="inputMode === 'push_to_talk'"
          :aria-describedby="`${idBase}-ptt-desc`"
          data-testid="input-mode-push-to-talk"
          @change="setInputMode('push_to_talk')"
        />
        <span class="radio-custom" :class="{ checked: inputMode === 'push_to_talk' }" aria-hidden="true">
          <span class="radio-inner"></span>
        </span>
        <span class="mode-content">
          <span class="mode-title">{{ t('settings.voice.pushToTalk') }}</span>
          <small :id="`${idBase}-ptt-desc`" class="mode-description">{{ t('settings.voice.pushToTalkDesc') }}</small>
        </span>
      </label>
    </fieldset>

    <div v-if="inputMode === 'voice_activity'" class="sensitivity-settings" data-testid="input-sensitivity">
      <fieldset class="setting-group sensitivity-modes">
        <legend class="setting-label">{{ t('settings.voice.inputSensitivity') }}</legend>
        <small :id="`${idBase}-sens-desc`" class="setting-hint sensitivity-desc">{{ t('settings.voice.inputSensitivityDesc') }}</small>
        <div class="sensitivity-choices" role="presentation">
          <label
            v-for="option in sensitivityOptions"
            :key="option.value"
            class="sensitivity-choice"
            :class="{ active: sensitivity === option.value }"
          >
            <input
              type="radio"
              class="input-mode-radio"
              :name="`${idBase}-sensitivity`"
              :value="option.value"
              :checked="sensitivity === option.value"
              :aria-describedby="`${idBase}-sens-desc`"
              :data-testid="`input-sensitivity-${option.value}`"
              @change="setSensitivity(option.value)"
            />
            {{ option.label }}
          </label>
        </div>
      </fieldset>

      <div v-if="sensitivity === 'manual'" class="setting-group">
        <label :for="`${idBase}-threshold`" class="setting-label">
          {{ t('settings.voice.inputThreshold') }}
          <span class="setting-value" aria-hidden="true">{{ t('settings.voice.decibels', { db: thresholdDb }) }}</span>
        </label>
        <input
          :id="`${idBase}-threshold`"
          type="range"
          :value="thresholdDb"
          :min="INPUT_THRESHOLD_MIN_DB"
          :max="INPUT_THRESHOLD_MAX_DB"
          step="1"
          class="setting-slider"
          :aria-valuetext="t('settings.voice.decibels', { db: thresholdDb })"
          :aria-describedby="`${idBase}-meter-hint`"
          data-testid="input-threshold"
          @input="setThreshold(Number(($event.target as HTMLInputElement).value))"
        />
      </div>

      <div v-if="sensitivity !== 'off'" class="setting-group">
        <div
          class="sensitivity-meter"
          role="meter"
          :aria-label="t('settings.voice.micLevel')"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="inputLevel"
          data-testid="input-sensitivity-meter"
        >
          <div class="sensitivity-meter-fill" :class="{ open: gateOpen }" :style="{ width: `${inputLevel}%` }"></div>
          <div
            v-if="sensitivity === 'manual'"
            class="sensitivity-meter-mark"
            :style="{ left: `${thresholdPercent}%` }"
            aria-hidden="true"
          ></div>
        </div>
        <small :id="`${idBase}-meter-hint`" class="setting-hint">
          {{ inCall ? t('settings.voice.inputMeterHint') : t('settings.voice.inputMeterIdle') }}
        </small>
      </div>
    </div>

    <div v-if="inputMode === 'push_to_talk'" class="ptt-settings">
      <div class="setting-group">
        <span :id="`${idBase}-ptt-label`" class="setting-label">{{ t('settings.voice.pttShortcut') }}</span>
        <KeybindRecorder
          class="ptt-recorder"
          action="push-to-talk"
          :name="t('settings.keybinds.actions.pushToTalk.name')"
          :describedby="`${idBase}-ptt-hint`"
        />
        <small :id="`${idBase}-ptt-hint`" class="setting-hint">{{ captureScopeHint }}</small>
      </div>

      <div class="setting-group">
        <label :for="`${idBase}-delay`" class="setting-label">
          {{ t('settings.voice.releaseDelay') }}
          <span class="setting-value" aria-hidden="true">{{ t('settings.voice.milliseconds', { ms: releaseDelay }) }}</span>
        </label>
        <input
          :id="`${idBase}-delay`"
          type="range"
          v-model.number="localReleaseDelay"
          min="0"
          max="500"
          step="50"
          class="setting-slider"
          :aria-valuetext="t('settings.voice.millisecondsLong', { ms: localReleaseDelay })"
          :aria-describedby="`${idBase}-delay-hint`"
          data-testid="ptt-release-delay"
          @input="ptt.setReleaseDelay(localReleaseDelay)"
        />
        <small :id="`${idBase}-delay-hint`" class="setting-hint">{{ t('settings.voice.releaseDelayHint') }}</small>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue';
import { usePushToTalk } from '@/composables/usePushToTalk';
import { useKeybinds } from '@/composables/useKeybinds';
import { useT } from '@/composables/useT';
import { uid } from '@/utils/a11y/focus';
import { isTauriDesktop, isMobileUserAgent } from '@/utils/platform';
import KeybindRecorder from './KeybindRecorder.vue';
import {
  INPUT_THRESHOLD_MAX_DB,
  INPUT_THRESHOLD_MIN_DB,
  VoiceSettingsService,
  normalizeInputThreshold,
  type InputSensitivity,
} from '@/services/VoiceSettingsService';
import { webrtcManager } from '@/services/webrtcManager';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { SPEAKING_LEVEL, dbfsToLevel } from '@/services/voice/speakingDetector';

const emit = defineEmits<{ 'input-mode-change': [mode: 'voice_activity' | 'push_to_talk'] }>();

const { t } = useT();
const ptt = usePushToTalk();
const keybinds = useKeybinds();
const inputMode = ptt.inputMode;
const releaseDelay = ptt.releaseDelay;
const localReleaseDelay = ref(ptt.releaseDelay.value);
const idBase = uid('input-mode');
const groupName = `${idBase}-mode`;

const captureScopeHint = computed(() => {
  if (isMobileUserAgent()) return t('settings.voice.pttScopeMobile');
  if (isTauriDesktop()) {
    return keybinds.nativePttAvailable.value === false
      ? t('settings.voice.pttScopeDesktopFocused')
      : t('settings.voice.pttScopeDesktop');
  }
  return t('settings.voice.pttScopeBrowser');
});

function setInputMode(mode: 'voice_activity' | 'push_to_talk') {
  ptt.setInputMode(mode);
  emit('input-mode-change', mode);
}

const voiceStore = useUnifiedVoiceChannelStore();
const initialSensitivity = VoiceSettingsService.getInputSensitivity();
const sensitivity = ref<InputSensitivity>(initialSensitivity.mode);
const thresholdDb = ref(initialSensitivity.thresholdDb);
const inputLevel = ref(0);
const inCall = computed(() => voiceStore.isConnected && voiceStore.connectionMode === 'livekit');
const thresholdPercent = computed(() => dbfsToLevel(thresholdDb.value));
// The local level crosses SPEAKING_LEVEL exactly while the detector, and so the gate, is open.
const gateOpen = computed(() => voiceStore.localState.audioLevel > SPEAKING_LEVEL && !voiceStore.localState.isMuted);

const sensitivityOptions = computed((): Array<{ value: InputSensitivity; label: string }> => [
  { value: 'off', label: t('settings.voice.inputSensitivityOff') },
  { value: 'auto', label: t('settings.voice.inputSensitivityAuto') },
  { value: 'manual', label: t('settings.voice.inputSensitivityManual') },
]);

function applySensitivity(): void {
  VoiceSettingsService.updateMany({ inputSensitivity: sensitivity.value, inputThresholdDb: thresholdDb.value });
  webrtcManager.setInputSensitivity(sensitivity.value, thresholdDb.value);
}

function setSensitivity(mode: InputSensitivity): void {
  sensitivity.value = mode;
  applySensitivity();
}

function setThreshold(db: number): void {
  thresholdDb.value = normalizeInputThreshold(db);
  applySensitivity();
}

let meterTimer: ReturnType<typeof setInterval> | null = null;
function stopMeter(): void {
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = null;
  inputLevel.value = 0;
}
watch(
  () => sensitivity.value !== 'off' && inputMode.value === 'voice_activity' && inCall.value,
  (active) => {
    stopMeter();
    if (active) meterTimer = setInterval(() => { inputLevel.value = webrtcManager.getLocalInputLevel(); }, 50);
  },
  { immediate: true },
);
onBeforeUnmount(stopMeter);
</script>

<style scoped>
.input-mode-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 0 20px 0;
  padding: 0;
  border: none;
  min-width: 0;
}
.input-mode-option {
  position: relative;
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
/* Native radio carries focus and state; the drawn circle shows it. */
.input-mode-radio {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
  margin: 0;
  pointer-events: none;
}
.input-mode-option:has(.input-mode-radio:focus-visible) {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
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
  display: block;
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
.ptt-settings,
.sensitivity-settings {
  padding-top: 16px;
  border-top: 1px solid var(--border-primary);
}
.sensitivity-modes {
  border: none;
  padding: 0;
  margin: 0 0 16px 0;
  min-width: 0;
}
.sensitivity-desc {
  margin: 0 0 10px 0;
}
.sensitivity-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.sensitivity-choice {
  position: relative;
  padding: 6px 14px;
  border: 1px solid var(--border-primary);
  border-radius: 999px;
  background: var(--background-tertiary);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
}
.sensitivity-choice.active {
  background: var(--harmony-primary-light);
  border-color: var(--harmony-primary);
}
.sensitivity-choice:has(.input-mode-radio:focus-visible) {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}
.sensitivity-meter {
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: var(--background-tertiary);
  overflow: hidden;
}
.sensitivity-meter-fill {
  height: 100%;
  background: var(--text-muted);
  transition: width 50ms linear;
}
.sensitivity-meter-fill.open {
  background: var(--success);
}
.sensitivity-meter-mark {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  margin-left: -1px;
  background: var(--text-primary);
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
  color: var(--text-link);
  font-weight: 600;
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
.ptt-recorder {
  align-items: stretch;
}
.ptt-recorder :deep(.keybind-recorder__input) {
  width: 100%;
  padding: 12px 16px;
  font-size: 14px;
}
.setting-slider:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 4px;
}
.setting-hint {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
