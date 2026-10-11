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
import { ref, computed } from 'vue';
import { usePushToTalk } from '@/composables/usePushToTalk';
import { useKeybinds } from '@/composables/useKeybinds';
import { useT } from '@/composables/useT';
import { uid } from '@/utils/a11y/focus';
import { isTauriDesktop, isMobileUserAgent } from '@/utils/platform';
import KeybindRecorder from './KeybindRecorder.vue';

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
