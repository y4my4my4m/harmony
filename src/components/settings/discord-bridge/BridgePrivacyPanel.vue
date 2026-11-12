<template>
  <div class="privacy" data-testid="bridge-privacy">
    <p class="db-muted">{{ t('discordBridge.privacy.lead') }}</p>

    <form class="privacy-form" novalidate @submit.prevent="askRemove">
      <div class="db-field">
        <label class="db-label" :for="`${uid}-id`">{{ t('discordBridge.privacy.idLabel') }}</label>
        <input
          :id="`${uid}-id`"
          v-model.trim="discordId"
          class="db-input"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          maxlength="20"
          :aria-invalid="idError ? 'true' : undefined"
          :aria-describedby="`${uid}-id-help`"
          data-testid="privacy-id"
        />
        <p :id="`${uid}-id-help`" :class="idError ? 'db-field-error' : 'db-muted'" data-testid="privacy-id-help">
          {{ idError || t('discordBridge.privacy.idHelp') }}
        </p>
      </div>
      <button type="submit" class="btn btn-secondary btn-sm" :disabled="busy || !discordId" data-testid="privacy-remove">
        {{ t('discordBridge.privacy.remove') }}
      </button>
    </form>

    <div
      v-if="confirming"
      class="privacy-confirm"
      role="alertdialog"
      :aria-labelledby="`${uid}-confirm`"
      :data-testid="confirming === 'user' ? 'privacy-remove-confirm' : 'privacy-purge-confirm'"
    >
      <p :id="`${uid}-confirm`" class="db-text">
        {{ confirming === 'user'
          ? t('discordBridge.privacy.removeConfirm', { id: discordId })
          : t('discordBridge.privacy.purgeConfirm') }}
      </p>
      <div class="db-actions">
        <button type="button" class="btn btn-danger btn-sm" :disabled="busy" data-testid="privacy-confirm-yes" @click="runConfirmed">
          {{ confirming === 'user' ? t('discordBridge.privacy.removeYes') : t('discordBridge.privacy.purgeYes') }}
        </button>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" data-testid="privacy-confirm-no" @click="confirming = null">
          {{ t('discordBridge.import.cancel') }}
        </button>
      </div>
    </div>

    <p v-if="progress !== null" class="db-muted" role="status" aria-live="polite" data-testid="privacy-progress">
      {{ t('discordBridge.privacy.progress', { count: progress }, progress) }}
    </p>

    <template v-if="optouts.length > 0">
      <h4 class="db-card-sub">{{ t('discordBridge.privacy.listTitle', { count: optouts.length }, optouts.length) }}</h4>
      <ul class="privacy-list" data-testid="privacy-list">
        <li v-for="row in optouts" :key="row.remote_user_id" class="privacy-row" data-testid="privacy-row">
          <code class="privacy-id">{{ row.remote_user_id }}</code>
          <span class="privacy-source">{{ t(`discordBridge.privacy.source.${row.source}`) }}</span>
          <button
            v-if="row.source !== 'self'"
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy"
            :aria-label="t('discordBridge.privacy.restoreLabel', { id: row.remote_user_id })"
            data-testid="privacy-restore"
            @click="restore(row.remote_user_id)"
          >
            {{ t('discordBridge.privacy.restore') }}
          </button>
        </li>
      </ul>
    </template>

    <div class="privacy-purge">
      <p class="db-muted">{{ t('discordBridge.privacy.purgeLead') }}</p>
      <button type="button" class="btn btn-danger btn-sm" :disabled="busy" data-testid="privacy-purge" @click="confirming = 'all'">
        {{ t('discordBridge.privacy.purge') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import {
  fetchBridgeOptouts,
  purgeBridgedMessages,
  removeBridgedUser,
  restoreBridgedUser,
  type BridgeOptout,
} from './bridgeApi'
import { bridgeErrorKey } from './bridgeErrors'

const props = defineProps<{ serverId: string }>()

// A Discord user id: a snowflake of up to 20 digits.
const DISCORD_ID = /^[0-9]{5,20}$/

const { t } = useI18n()
const toast = useToast()
const uid = `bridge-privacy-${useId()}`

const optouts = ref<BridgeOptout[]>([])
const discordId = ref('')
const idError = ref('')
const busy = ref(false)
const confirming = ref<'user' | 'all' | null>(null)
/** Messages removed so far by the running erase; null when none runs. */
const progress = ref<number | null>(null)

async function load() {
  try {
    optouts.value = await fetchBridgeOptouts(props.serverId)
  } catch (error) {
    debug.warn('bridge_remote_optouts read failed:', error)
  }
}

onMounted(load)
watch(() => props.serverId, load)
watch(discordId, () => { idError.value = '' })

function askRemove() {
  if (!DISCORD_ID.test(discordId.value)) {
    idError.value = t('discordBridge.privacy.idInvalid')
    return
  }
  confirming.value = 'user'
}

async function runConfirmed() {
  const scope = confirming.value
  if (!scope) return
  confirming.value = null
  busy.value = true
  progress.value = 0
  try {
    const onProgress = (total: number) => { progress.value = total }
    if (scope === 'user') {
      const removed = await removeBridgedUser(props.serverId, discordId.value, onProgress)
      toast.success(t('discordBridge.privacy.removed', { count: removed }, removed))
      discordId.value = ''
    } else {
      const removed = await purgeBridgedMessages(props.serverId, onProgress)
      toast.success(t('discordBridge.privacy.purged', { count: removed }, removed))
    }
  } catch (error) {
    debug.error('bridge privacy erase failed:', error)
    toast.error(t(bridgeErrorKey(error, 'discordBridge.errors.privacy')))
  } finally {
    progress.value = null
    busy.value = false
  }
  await load()
}

async function restore(id: string) {
  busy.value = true
  try {
    await restoreBridgedUser(props.serverId, id)
  } catch (error) {
    debug.error('bridge_privacy_restore_remote_user failed:', error)
    toast.error(t(bridgeErrorKey(error, 'discordBridge.errors.privacy')))
  } finally {
    busy.value = false
  }
  await load()
}
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.privacy-form {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.privacy-form .db-field {
  flex: 1 1 220px;
  margin-bottom: 0;
}

.privacy-form .btn {
  margin-bottom: 24px;
}

.privacy-confirm {
  padding: 12px;
  margin-bottom: 12px;
  border-radius: 8px;
  border: 1px solid var(--error);
}

.privacy-confirm p {
  margin: 0 0 8px;
}

.privacy-list {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
}

.privacy-row {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  padding: 6px 0;
  border-bottom: 1px solid var(--background-quaternary);
  font-size: 13px;
}

.privacy-id {
  color: var(--text-primary);
}

.privacy-source {
  flex: 1 1 auto;
  color: var(--text-secondary);
}

.privacy-purge {
  padding-top: 12px;
  border-top: 1px solid var(--background-quaternary);
}
</style>
