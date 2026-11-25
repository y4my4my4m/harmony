<template>
  <section class="vi-card" :aria-labelledby="`${uid}-title`" data-testid="voice-ice-settings">
    <h3 :id="`${uid}-title`" class="vi-title">{{ t('adminVoiceIce.title') }}</h3>
    <p class="vi-hint">{{ t('adminVoiceIce.intro') }}</p>

    <p v-if="loadError" class="vi-error" role="alert">{{ loadError }}</p>

    <form v-else-if="form" class="vi-form" novalidate @submit.prevent="save">
      <label class="vi-check">
        <input v-model="form.stunDefault" type="checkbox" data-testid="voice-ice-stun-default" />
        <span>{{ t('adminVoiceIce.stunDefault') }}</span>
      </label>
      <span class="vi-hint">{{ t('adminVoiceIce.stunDefaultHint', { urls: defaultStun }) }}</span>

      <template v-if="!form.stunDefault">
        <label class="vi-label" :for="`${uid}-stun`">{{ t('adminVoiceIce.stunUrls') }}</label>
        <textarea
          :id="`${uid}-stun`"
          v-model="stunText"
          class="vi-input"
          rows="2"
          spellcheck="false"
          autocapitalize="off"
          :aria-invalid="fieldError === 'stun' ? 'true' : undefined"
          :aria-describedby="`${uid}-stun-hint`"
          data-testid="voice-ice-stun-urls"
        />
        <span :id="`${uid}-stun-hint`" class="vi-hint">{{ t('adminVoiceIce.stunUrlsHint') }}</span>
      </template>

      <label class="vi-label" :for="`${uid}-turn`">{{ t('adminVoiceIce.turnUrls') }}</label>
      <textarea
        :id="`${uid}-turn`"
        v-model="turnText"
        class="vi-input"
        rows="2"
        spellcheck="false"
        autocapitalize="off"
        :aria-invalid="fieldError === 'turn' ? 'true' : undefined"
        :aria-describedby="`${uid}-turn-hint`"
        data-testid="voice-ice-turn-urls"
      />
      <span :id="`${uid}-turn-hint`" class="vi-hint">{{ t('adminVoiceIce.turnUrlsHint') }}</span>

      <fieldset class="vi-modes">
        <legend class="vi-label">{{ t('adminVoiceIce.turnAuth') }}</legend>
        <label class="vi-check">
          <input v-model="form.turnAuth" type="radio" value="secret" data-testid="voice-ice-auth-secret" />
          <span>{{ t('adminVoiceIce.turnAuthSecret') }}</span>
        </label>
        <span class="vi-hint">{{ t('adminVoiceIce.turnAuthSecretHint') }}</span>
        <label class="vi-check">
          <input v-model="form.turnAuth" type="radio" value="password" data-testid="voice-ice-auth-password" />
          <span>{{ t('adminVoiceIce.turnAuthPassword') }}</span>
        </label>
      </fieldset>

      <template v-if="form.turnAuth === 'password'">
        <label class="vi-label" :for="`${uid}-user`">{{ t('adminVoiceIce.username') }}</label>
        <input
          :id="`${uid}-user`"
          v-model="form.turnUsername"
          class="vi-input"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :aria-invalid="fieldError === 'username' ? 'true' : undefined"
          data-testid="voice-ice-username"
        />
      </template>

      <label class="vi-label" :for="`${uid}-secret`">
        {{ form.turnAuth === 'password' ? t('adminVoiceIce.password') : t('adminVoiceIce.secret') }}
      </label>
      <input
        :id="`${uid}-secret`"
        v-model="secret"
        class="vi-input"
        type="password"
        autocomplete="new-password"
        :placeholder="saved?.secretSet ? t('adminVoiceIce.secretKept') : ''"
        :aria-invalid="fieldError === 'secret' ? 'true' : undefined"
        data-testid="voice-ice-secret"
      />

      <p class="vi-error" role="alert" data-testid="voice-ice-error">{{ formError }}</p>
      <div>
        <button type="submit" class="vi-btn" :disabled="saving || !changed" data-testid="voice-ice-save">
          {{ t('adminVoiceIce.save') }}
        </button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useAuthStore } from '@/stores/auth'
import { DEFAULT_ICE_SERVERS } from '@/services/voice/iceServers'
import {
  invalidUrls,
  loadIceServerSettings,
  parseUrlLines,
  saveIceServerSettings,
  type IceServerSettings,
} from '@/services/voice/iceServerSettings'
import { debug } from '@/utils/debug'

const { t } = useI18n()
const toast = useToast()
const authStore = useAuthStore()
const uid = useId()
const defaultStun = DEFAULT_ICE_SERVERS.flatMap((server) => [server.urls].flat()).join(', ')

const saved = ref<IceServerSettings | null>(null)
const form = ref<IceServerSettings | null>(null)
const stunText = ref('')
const turnText = ref('')
const secret = ref('')
const loadError = ref('')
const formError = ref('')
const fieldError = ref<'stun' | 'turn' | 'username' | 'secret' | null>(null)
const saving = ref(false)

function current(): IceServerSettings | null {
  if (!form.value) return null
  return {
    ...form.value,
    stunUrls: form.value.stunDefault ? [] : parseUrlLines(stunText.value),
    turnUrls: parseUrlLines(turnText.value),
    turnUsername: form.value.turnUsername.trim(),
  }
}

const normalized = (s: IceServerSettings) => JSON.stringify({ ...s, stunUrls: s.stunDefault ? [] : s.stunUrls })

const changed = computed(() => {
  const next = current()
  if (!next || !saved.value) return false
  return secret.value.trim() !== '' || normalized(next) !== normalized(saved.value)
})

function fill(settings: IceServerSettings) {
  saved.value = settings
  form.value = { ...settings }
  stunText.value = settings.stunUrls.join('\n')
  turnText.value = settings.turnUrls.join('\n')
  secret.value = ''
}

async function save() {
  const next = current()
  if (!next || !saved.value || saving.value) return
  formError.value = ''
  fieldError.value = null
  const badStun = next.stunDefault ? [] : invalidUrls(next.stunUrls, 'stun')
  if (badStun.length > 0) {
    fieldError.value = 'stun'
    formError.value = t('adminVoiceIce.invalidStun', { url: badStun[0] })
    return
  }
  const badTurn = invalidUrls(next.turnUrls, 'turn')
  if (badTurn.length > 0) {
    fieldError.value = 'turn'
    formError.value = t('adminVoiceIce.invalidTurn', { url: badTurn[0] })
    return
  }
  if (next.turnUrls.length > 0) {
    if (next.turnAuth === 'password' && next.turnUsername === '') {
      fieldError.value = 'username'
      formError.value = t('adminVoiceIce.needsUsername')
      return
    }
    if (secret.value.trim() === '' && !saved.value.secretSet) {
      fieldError.value = 'secret'
      formError.value = t('adminVoiceIce.needsSecret')
      return
    }
  }
  saving.value = true
  try {
    await saveIceServerSettings(next, saved.value, secret.value, authStore.session?.user?.id ?? '')
    fill({ ...next, secretSet: saved.value.secretSet || secret.value.trim() !== '' })
    toast.success(t('adminVoiceIce.saved'))
  } catch (error) {
    debug.error('Saving the ICE servers failed:', error)
    formError.value = t('adminVoiceIce.saveFailed')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    fill(await loadIceServerSettings())
  } catch (error) {
    debug.error('Loading the ICE servers failed:', error)
    loadError.value = t('adminVoiceIce.loadFailed')
  }
})
</script>

<style scoped>
.vi-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  margin-top: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  min-width: 0;
}

.vi-title {
  margin: 0;
  font-size: var(--font-size-md, 1rem);
  font-weight: 600;
  color: var(--text-primary);
}

.vi-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.vi-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 480px;
}

.vi-label {
  margin: var(--space-2) 0 0;
  padding: 0;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.vi-input {
  width: 100%;
  min-width: 0;
  background: var(--background-quinary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  padding: 8px 10px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
  resize: vertical;
}

.vi-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.vi-input[aria-invalid='true'] {
  border-color: var(--danger);
}

.vi-modes {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  border: 0;
}

.vi-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.vi-error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--danger);
}

.vi-error:empty {
  display: none;
}

.vi-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
}

.vi-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
