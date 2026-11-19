<!--
  SpeakMessageSettings - "Spoken messages" for Settings > Appearance > the
  Accessibility section. Picks the voice source used by the "Speak message"
  context-menu action and, for an external service, its base URL, voice, model
  and key.

  Kept per device per account in userStorage, applied at once (outside the
  appearance save bar), never synced to the account or sent to a Harmony
  server. A "Stop" button appears while a message is being spoken.
-->
<template>
  <div class="setting-item speak-settings">
    <div class="speak-row">
      <div class="speak-info">
        <h4 :id="labelId" class="speak-label">{{ t('messageTts.settings.label') }}</h4>
        <p :id="descId" class="speak-desc">{{ t('messageTts.settings.description') }}</p>
      </div>
      <div class="speak-controls">
        <label :for="providerId" class="sr-only">{{ t('messageTts.settings.provider') }}</label>
        <select :id="providerId" v-model="settings.provider" class="speak-select">
          <option value="browser">{{ t('messageTts.settings.providerBrowser') }}</option>
          <option value="elevenlabs">{{ t('messageTts.settings.providerExternal') }}</option>
        </select>
        <button
          v-if="isSpeaking"
          type="button"
          class="btn btn-secondary speak-stop"
          data-testid="speak-stop"
          @click="stopMessageSpeech"
        >
          {{ t('messageTts.menu.stop') }}
        </button>
      </div>
    </div>

    <p v-if="settings.provider === 'browser' && !browserSupported" class="speak-warning" data-testid="speak-unsupported">
      {{ t('messageTts.errors.unsupported') }}
    </p>

    <template v-if="settings.provider === 'elevenlabs'">
      <p class="speak-disclosure" data-testid="speak-external-disclosure">{{ t('messageTts.settings.disclosure') }}</p>

      <div class="speak-field">
        <label :for="baseInputId" class="speak-field-label">{{ t('messageTts.settings.baseUrl') }}</label>
        <input
          :id="baseInputId"
          v-model.trim="settings.baseUrl"
          type="url"
          class="speak-input"
          spellcheck="false"
          autocomplete="off"
          data-testid="speak-base-url"
        />
        <p class="speak-field-hint">{{ t('messageTts.settings.baseUrlHint') }}</p>
      </div>

      <div class="speak-field">
        <label :for="voiceInputId" class="speak-field-label">{{ t('messageTts.settings.voiceId') }}</label>
        <input
          :id="voiceInputId"
          v-model.trim="settings.voiceId"
          type="text"
          class="speak-input"
          spellcheck="false"
          autocomplete="off"
          data-testid="speak-voice-id"
        />
      </div>

      <div class="speak-field">
        <label :for="modelInputId" class="speak-field-label">{{ t('messageTts.settings.modelId') }}</label>
        <input
          :id="modelInputId"
          v-model.trim="settings.modelId"
          type="text"
          class="speak-input"
          :placeholder="DEFAULT_TTS_MODEL_ID"
          spellcheck="false"
          autocomplete="off"
          data-testid="speak-model-id"
        />
      </div>

      <div class="speak-field">
        <label :for="keyInputId" class="speak-field-label">{{ t('messageTts.settings.apiKey') }}</label>
        <input
          :id="keyInputId"
          v-model="settings.apiKey"
          type="password"
          class="speak-input"
          autocomplete="off"
          data-testid="speak-api-key"
        />
        <p class="speak-field-hint">{{ t('messageTts.settings.apiKeyHint') }}</p>
      </div>
    </template>

    <p class="speak-privacy">{{ t('messageTts.settings.privacy') }}</p>

    <p v-if="saveError" class="speak-save-error" role="status" data-testid="speak-save-error">
      {{ saveError }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { getActivePinia } from 'pinia'
import { useT } from '@/composables/useT'
import { uid } from '@/utils/a11y/focus'
import { userStorage } from '@/utils/userScopedStorage'
import { useAuthStore } from '@/stores/auth'
import {
  DEFAULT_TTS_BASE_URL,
  DEFAULT_TTS_MODEL_ID,
  isMessageTtsSupported,
  isSpeaking,
  loadMessageTtsSettings,
  saveMessageTtsSettings,
  stopMessageSpeech,
  type MessageTtsSettings,
} from '@/services/messageTts'

const { t } = useT()

const labelId = uid('speak-label')
const descId = uid('speak-desc')
const providerId = uid('speak-provider')
const baseInputId = uid('speak-base')
const voiceInputId = uid('speak-voice')
const modelInputId = uid('speak-model')
const keyInputId = uid('speak-key')

const browserSupported = isMessageTtsSupported()

// Nothing configured for the signed-in user yet.
const EMPTY_SETTINGS: MessageTtsSettings = {
  provider: 'browser',
  baseUrl: DEFAULT_TTS_BASE_URL,
  voiceId: '',
  modelId: '',
  apiKey: '',
}

// The account this reactive copy belongs to. A save from any other account is
// refused, so user A's settings can never be written under user B.
let loadedOwnerId: string | null = userStorage.getCurrentUser()

// Loaded when the section mounts; the service reads it again on each use, so a
// change on another tab or account is picked up without a stale cached copy.
const settings = reactive(loadMessageTtsSettings())
const saveError = ref('')

watch(settings, () => {
  if (loadedOwnerId === null || loadedOwnerId !== userStorage.getCurrentUser()) return
  saveError.value = saveMessageTtsSettings(settings) ? '' : t('messageTts.settings.saveError')
}, { deep: true })

/**
 * Drop a previous account's copy at once, then load the new account's. Runs
 * before the settings watcher flushes, so a switch never writes the old
 * account's values over the new account's stored config.
 */
function onAccountChange(userId: string | null): void {
  stopMessageSpeech()
  Object.assign(settings, EMPTY_SETTINGS)
  saveError.value = ''
  loadedOwnerId = null
  // userStorage is switched with the session; if it has not caught up yet,
  // show nothing rather than the previous account's values.
  if (userId && userStorage.getCurrentUser() === userId) {
    Object.assign(settings, loadMessageTtsSettings())
    loadedOwnerId = userId
  }
}

onMounted(() => {
  // The settings page always runs under Pinia; an isolated test may not.
  if (!getActivePinia()) return
  const auth = useAuthStore()
  watch(() => auth.session?.user?.id ?? null, onAccountChange)
})
</script>

<style scoped>
/* The root is also `.setting-item`, which the settings page styles (border,
   padding). These settings run full width inside it. */
.setting-item.speak-settings {
  display: block;
}

.speak-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.speak-info {
  flex: 1;
}

.speak-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.speak-desc {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.speak-controls {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.speak-select,
.speak-input {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  padding: 6px 8px;
}

.speak-select:focus-visible,
.speak-input:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.speak-warning {
  margin: 8px 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-danger);
}

.speak-disclosure {
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
  background: var(--background-secondary);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: 1.45;
}

.speak-field {
  margin-top: 12px;
}

.speak-field-label {
  display: block;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 4px;
}

.speak-input {
  width: 100%;
  box-sizing: border-box;
}

.speak-field-hint,
.speak-privacy {
  margin: 4px 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: 1.4;
}

.speak-privacy {
  margin-top: 12px;
}

.speak-save-error {
  margin: 6px 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-danger);
}

@media (max-width: 768px) {
  .speak-row {
    flex-direction: column;
  }

  .speak-controls {
    width: 100%;
  }
}
</style>
