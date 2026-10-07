<template>
  <form data-testid="connect-hosted" novalidate @submit.prevent="save">
    <p class="db-text">{{ t('discordBridge.hosted.lead') }}</p>
    <div class="db-banner db-banner--warn">
      <p>{{ t('discordBridge.hosted.access') }}</p>
    </div>

    <div class="db-field">
      <label :for="inputId" class="db-label">{{ t('discordBridge.hosted.tokenLabel') }}</label>
      <div class="token-row">
        <input
          :id="inputId"
          v-model="token"
          :type="reveal ? 'text' : 'password'"
          class="db-input token-input"
          name="discord-bot-token"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          data-1p-ignore
          data-lpignore="true"
          :placeholder="t('discordBridge.hosted.tokenPlaceholder')"
          :aria-invalid="!!issueMessage || undefined"
          :aria-describedby="issueMessage ? `${inputId}-error ${inputId}-hint` : `${inputId}-hint`"
          data-testid="hosted-token"
          @input="touched = false"
        />
        <button
          type="button"
          class="btn btn-secondary"
          :aria-pressed="reveal"
          :aria-controls="inputId"
          @click="reveal = !reveal"
        >
          {{ reveal ? t('discordBridge.hosted.hide') : t('discordBridge.hosted.show') }}
        </button>
      </div>
      <p :id="`${inputId}-hint`" class="db-muted hint">{{ t('discordBridge.hosted.tokenHint') }}</p>
      <p v-if="issueMessage" :id="`${inputId}-error`" class="db-field-error" role="alert" data-testid="token-error">
        {{ issueMessage }}
      </p>
    </div>

    <div v-if="saveError" class="db-banner db-banner--error" role="alert">
      <p>{{ saveError }}</p>
      <p v-if="saveDetail" class="db-muted">{{ saveDetail }}</p>
    </div>

    <div v-if="savedOnce" class="db-banner db-banner--success" role="status" data-testid="token-saved">
      <p>{{ t('discordBridge.hosted.saved') }}</p>
    </div>

    <div class="db-actions">
      <button type="submit" class="btn btn-primary" :disabled="saving" data-testid="save-token">
        {{ saving ? t('discordBridge.hosted.saving') : t('discordBridge.hosted.save') }}
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import { checkDiscordToken } from '@/utils/discordBridgeSetup'
import { setHostedToken } from './bridgeApi'
import { bridgeErrorKey, errorDetail } from './bridgeErrors'

const props = defineProps<{ bridgeId: string }>()
const emit = defineEmits<{ saved: [] }>()

const { t } = useI18n()
const inputId = `bridge-token-${useId()}`

const token = ref('')
const reveal = ref(false)
const touched = ref(false)
const saving = ref(false)
const saveError = ref('')
const saveDetail = ref('')
const savedOnce = ref(false)

const check = computed(() => checkDiscordToken(token.value))
const issueMessage = computed(() =>
  touched.value && check.value.issue ? t(`discordBridge.hosted.issue.${check.value.issue}`) : '',
)

async function save() {
  touched.value = true
  saveError.value = ''
  saveDetail.value = ''
  if (check.value.issue) return
  saving.value = true
  try {
    await setHostedToken(props.bridgeId, check.value.token)
    token.value = ''
    touched.value = false
    reveal.value = false
    savedOnce.value = true
    emit('saved')
  } catch (error) {
    debug.error('discord_bridge_set_hosted_token failed:', error)
    saveError.value = t(bridgeErrorKey(error, 'discordBridge.errors.saveToken'))
    saveDetail.value = errorDetail(error)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.token-row {
  display: flex;
  gap: 8px;
  max-width: 560px;
}

.token-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono, ui-monospace, monospace);
}

.hint {
  margin: 0;
}
</style>
