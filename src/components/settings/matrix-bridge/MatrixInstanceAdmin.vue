<template>
  <div class="admin-card" data-testid="matrix-instance-admin">
    <h4>{{ t('matrixBridge.admin.instance.title') }}</h4>
    <p class="hint">{{ t('matrixBridge.admin.instance.lead') }}</p>

    <p v-if="loadError" class="error" role="alert">{{ t('matrixBridge.admin.loadFailed') }}</p>

    <template v-if="status">
      <p class="summary" data-testid="matrix-instance-summary">
        <span>{{ summary }}</span>
        <span data-testid="matrix-instance-count">{{ t('matrixBridge.admin.instance.linkedCount', { count: status.linkedCount, limit: status.limit }) }}</span>
      </p>

      <form class="credentials" novalidate data-testid="matrix-instance-form" @submit.prevent="save">
        <fieldset class="connection-pick" :disabled="busy">
          <legend class="title">{{ t('matrixBridge.self.connection.label') }}</legend>
          <label v-for="c in CONNECTIONS" :key="c" class="connection-option">
            <input v-model="form.connection" type="radio" :name="`${uid}-connection`" :value="c" :data-testid="`matrix-instance-${c}`" />
            <span>
              {{ t(`matrixBridge.managed.connectionKind.${c}`) }}
              <span class="hint option-hint">{{ t(`matrixBridge.admin.instance.connection.${c}`) }}</span>
            </span>
          </label>
        </fieldset>

        <div v-for="field in fields" :key="field.name" class="field">
          <label :for="`${uid}-${field.name}`" class="title">{{ t(field.label) }}</label>
          <input
            :id="`${uid}-${field.name}`"
            v-model.trim="form[field.name]"
            type="text"
            :inputmode="field.url ? 'url' : 'text'"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            maxlength="255"
            class="cyber-input mono"
            :placeholder="field.placeholder"
            :disabled="busy"
            :aria-invalid="field.invalid ? 'true' : undefined"
            :aria-describedby="field.invalid ? `${uid}-${field.name}-error` : undefined"
            :data-testid="`matrix-instance-${field.name}`"
          />
          <span v-if="field.invalid" :id="`${uid}-${field.name}-error`" class="error" role="alert">
            {{ t(field.error) }}
          </span>
        </div>

        <div v-if="form.connection === 'account'" class="field">
          <label :for="`${uid}-token`" class="title">
            {{ t('matrixBridge.hosted.token') }}
            <span :class="['state', tokenKept ? 'state--ok' : '']" data-testid="matrix-instance-token-state">
              {{ t(tokenKept ? 'discordBridge.instanceAdmin.stored' : 'discordBridge.instanceAdmin.notStored') }}
            </span>
          </label>
          <input
            :id="`${uid}-token`"
            v-model="form.accessToken"
            type="password"
            autocomplete="new-password"
            spellcheck="false"
            data-1p-ignore
            data-lpignore="true"
            class="cyber-input mono"
            :placeholder="tokenKept ? t('discordBridge.instanceAdmin.keepPlaceholder') : ''"
            :disabled="busy"
            data-testid="matrix-instance-token"
          />
          <span v-if="tokenIssue" class="error" role="alert">{{ t(`matrixBridge.hosted.issue.${tokenIssue}`) }}</span>
          <span class="hint">{{ t('discordBridge.instanceAdmin.writeOnly') }}</span>
          <details class="login">
            <summary>{{ t('matrixBridge.admin.instance.login') }}</summary>
            <p class="hint">{{ t('matrixBridge.self.login') }}</p>
            <BridgeCopyBlock :text="buildMatrixLoginDocker(shellSafeUrl(form.homeserverUrl))" :label="t('discordBridge.common.commandLabel')" data-testid="matrix-instance-login" />
            <p class="hint">{{ t('matrixBridge.self.copiedToken') }}</p>
          </details>
        </div>

        <div class="buttons">
          <button type="submit" class="btn btn-primary" :disabled="!savable" data-testid="matrix-instance-save">
            {{ busy ? t('discordBridge.admin.saving') : t('matrixBridge.admin.instance.save') }}
          </button>
          <button
            v-if="status.connection && asking !== 'clear'"
            type="button"
            class="btn btn-secondary"
            :disabled="busy"
            data-testid="matrix-instance-clear"
            @click="asking = 'clear'"
          >
            {{ t('matrixBridge.admin.instance.clear') }}
          </button>
        </div>
      </form>

      <div v-if="status.connection === 'application_service'" class="registration" data-testid="matrix-instance-registration">
        <p class="title">
          {{ t('matrixBridge.admin.instance.registration.title') }}
          <span :class="['state', status.hasServiceTokens ? 'state--ok' : '']" data-testid="matrix-instance-registration-state">
            {{ t(status.hasServiceTokens ? 'matrixBridge.admin.instance.registration.made' : 'matrixBridge.admin.instance.registration.notMade') }}
          </span>
        </p>
        <p class="hint">
          <i18n-t keypath="matrixBridge.self.registration.install" tag="span" scope="global">
            <template #file><code>{{ MATRIX_REGISTRATION_FILE }}</code></template>
            <template #setting><code>app_service_config_files</code></template>
          </i18n-t>
          {{ t('matrixBridge.self.registration.secret') }}
        </p>
        <p v-if="registrationStale" class="note" role="alert" data-testid="matrix-instance-registration-stale">{{ t('matrixBridge.admin.instance.registration.stale') }}</p>
        <div class="buttons">
          <button
            v-if="asking !== 'registration'"
            type="button"
            class="btn btn-secondary"
            :disabled="busy"
            data-testid="matrix-instance-make-registration"
            @click="status.hasServiceTokens ? (asking = 'registration') : makeRegistration()"
          >
            {{ t(status.hasServiceTokens ? 'matrixBridge.admin.instance.registration.again' : 'matrixBridge.admin.instance.registration.make') }}
          </button>
        </div>
        <p v-if="downloaded" class="hint" role="status" data-testid="matrix-instance-downloaded">{{ t('matrixBridge.admin.instance.registration.downloaded') }}</p>
      </div>

      <div v-if="asking" class="confirm" role="alertdialog" :aria-labelledby="`${uid}-ask`" data-testid="matrix-instance-confirm">
        <p :id="`${uid}-ask`">{{ t(asking === 'clear' ? 'matrixBridge.admin.instance.clearConfirm' : 'matrixBridge.admin.instance.registration.confirm') }}</p>
        <div class="buttons">
          <button type="button" class="btn btn-danger" :disabled="busy" data-testid="matrix-instance-confirm-yes" @click="asking === 'clear' ? clear() : makeRegistration()">
            {{ t(asking === 'clear' ? 'matrixBridge.admin.instance.clear' : 'matrixBridge.admin.instance.registration.again') }}
          </button>
          <button type="button" class="btn btn-secondary" :disabled="busy" data-testid="matrix-instance-confirm-no" @click="asking = null">
            {{ t('discordBridge.instanceAdmin.cancel') }}
          </button>
        </div>
      </div>

      <div class="row">
        <div class="text">
          <span :id="`${uid}-enabled`" class="title">{{ t('matrixBridge.admin.instance.enable') }}</span>
          <span :id="`${uid}-enabled-hint`" class="hint">
            {{ t(status.configured ? 'matrixBridge.admin.instance.enableHint' : 'matrixBridge.admin.instance.enableNeedsConfig') }}
          </span>
        </div>
        <ToggleSwitch
          :model-value="enabled"
          :disabled="busy || switching || (!status.configured && !enabled)"
          :labelledby="`${uid}-enabled`"
          :describedby="`${uid}-enabled-hint`"
          data-testid="matrix-instance-enabled"
          @update:model-value="setEnabled"
        />
      </div>

      <div class="field">
        <label :for="`${uid}-limit`" class="title">{{ t('matrixBridge.admin.instance.limit') }}</label>
        <input
          :id="`${uid}-limit`"
          v-model.number="limit"
          type="number"
          min="0"
          step="1"
          inputmode="numeric"
          class="cyber-input limit-input"
          :disabled="busy || savingLimit"
          :aria-describedby="`${uid}-limit-hint`"
          data-testid="matrix-instance-limit"
        />
        <span :id="`${uid}-limit-hint`" class="hint">{{ t('matrixBridge.admin.instance.limitHint') }}</span>
        <span v-if="limitInvalid" class="error" role="alert">{{ t('discordBridge.admin.limitInvalid') }}</span>
      </div>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="busy || savingLimit || limit === status.limit || limitInvalid"
        data-testid="matrix-instance-save-limit"
        @click="saveLimit"
      >
        {{ savingLimit ? t('discordBridge.admin.saving') : t('discordBridge.admin.saveLimit') }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { debug } from '@/utils/debug'
import { saveBlob } from '@/services/AccountSecurityService'
import { resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'
import { checkMatrixToken } from '@/utils/matrixLogin'
import {
  MATRIX_REGISTRATION_FILE,
  buildMatrixLoginDocker,
  matrixServerName,
  shellSafeUrl,
  type MatrixConnection,
} from '@/utils/matrixBridgeSetup'
import { MATRIX_INSTANCE_ENABLED_KEY, MATRIX_INSTANCE_LIMIT_KEY, saveBridgeInstanceConfig } from '@/components/settings/discord-bridge/bridgeApi'
import BridgeCopyBlock from '@/components/settings/discord-bridge/BridgeCopyBlock.vue'
import {
  DEFAULT_MATRIX_INSTANCE_LIMIT,
  clearMatrixInstance,
  createMatrixRegistration,
  fetchMatrixInstanceStatus,
  saveMatrixInstance,
  type MatrixInstanceStatus,
} from './matrixAdminApi'

const CONNECTIONS: readonly MatrixConnection[] = ['application_service', 'account']
/** As harmony-matrix-bridge takes MATRIX_SENDER_LOCALPART. */
const LOCALPART = /^[a-z0-9._=-]+$/
/** '@' + sender + '_h_' + 32 hex digits + ':' + server name: a Harmony member's Matrix user, at most 255 characters. */
const GHOST_EXTRA = 37
const USER_ID_MAX = 255
const DEFAULT_LOCALPART = 'harmony_relay'

type FieldName = 'homeserverUrl' | 'serverName' | 'senderLocalpart' | 'appserviceUrl'

const emit = defineEmits<{ status: [status: MatrixInstanceStatus] }>()

const { t } = useI18n()
const toast = useToast()
const uid = `matrix-instance-${useId()}`

const status = ref<MatrixInstanceStatus | null>(null)
const loadError = ref(false)
const busy = ref(false)
const switching = ref(false)
const savingLimit = ref(false)
const asking = ref<'clear' | 'registration' | null>(null)
const downloaded = ref(false)
/** What the registration file carries was changed since it was made. */
const registrationStale = ref(false)

const form = reactive({
  connection: 'application_service' as MatrixConnection,
  homeserverUrl: '',
  accessToken: '',
  serverName: '',
  senderLocalpart: '',
  appserviceUrl: '',
})
const enabled = ref(false)
const limit = ref<number>(DEFAULT_MATRIX_INSTANCE_LIMIT)

/** A registration file is made for these: what it carries, and the homeserver that has it. */
const REGISTERED = ['homeserverUrl', 'serverName', 'senderLocalpart', 'appserviceUrl'] as const satisfies readonly FieldName[]

const VALID: Record<FieldName, (value: string) => boolean> = {
  homeserverUrl: (value) => shellSafeUrl(value) !== null,
  serverName: (value) => matrixServerName(value) === value,
  senderLocalpart: (value) => LOCALPART.test(value),
  appserviceUrl: (value) => shellSafeUrl(value) !== null,
}
const fields = computed(() => {
  const all: { name: FieldName; url: boolean; placeholder: string }[] = [
    { name: 'homeserverUrl', url: true, placeholder: 'https://matrix.example.org' },
    { name: 'serverName', url: false, placeholder: 'example.org' },
    { name: 'senderLocalpart', url: false, placeholder: DEFAULT_LOCALPART },
    { name: 'appserviceUrl', url: true, placeholder: `${resolveHarmonyBaseUrl()}/matrix-appservice` },
  ]
  return all
    .filter((field) => form.connection === 'application_service' || field.name === 'homeserverUrl')
    .map((field) => {
      const own = field.name === 'senderLocalpart'
      const tooLong = own && (form.senderLocalpart || DEFAULT_LOCALPART).length + form.serverName.length + GHOST_EXTRA > USER_ID_MAX
      return {
        ...field,
        label: own ? 'matrixBridge.admin.instance.senderLocalpart' : `matrixBridge.self.field.${field.name}.label`,
        error: !own
          ? `matrixBridge.self.field.${field.name}.invalid`
          : `matrixBridge.admin.instance.${tooLong ? 'tooLong' : 'invalidLocalpart'}`,
        invalid: tooLong || (form[field.name] !== '' && !VALID[field.name](form[field.name])),
      }
    })
})
/** Another homeserver does not get the stored token (matrix_bridge_instance_set). */
const tokenKept = computed(() => !!status.value?.hasAccessToken && form.homeserverUrl === status.value.homeserverUrl)
const tokenIssue = computed(() => (form.connection === 'account' && form.accessToken.trim() ? checkMatrixToken(form.accessToken).issue : null))

const savable = computed(() => {
  const current = status.value
  if (!current || busy.value || tokenIssue.value || fields.value.some((field) => field.invalid)) return false
  if (!form.homeserverUrl) return false
  if (form.connection === 'application_service') {
    if (!form.serverName) return false
    return (
      form.connection !== current.connection ||
      form.homeserverUrl !== current.homeserverUrl ||
      form.serverName !== current.serverName ||
      form.senderLocalpart !== current.senderLocalpart ||
      form.appserviceUrl !== current.appserviceUrl
    )
  }
  if (!form.accessToken.trim() && !tokenKept.value) return false
  return form.connection !== current.connection || form.accessToken.trim() !== ''
})
const summary = computed(() => {
  const current = status.value
  if (!current?.configured) return t('matrixBridge.admin.instance.notConfigured')
  return t('matrixBridge.admin.instance.configured', { homeserver: current.serverName || current.homeserverUrl })
})
const limitInvalid = computed(() => !Number.isInteger(limit.value) || limit.value < 0)

function apply(next: MatrixInstanceStatus) {
  status.value = next
  form.connection = next.connection ?? 'application_service'
  form.homeserverUrl = next.homeserverUrl
  form.serverName = next.serverName
  form.senderLocalpart = next.senderLocalpart
  form.appserviceUrl = next.appserviceUrl
  form.accessToken = ''
  enabled.value = next.enabled
  limit.value = next.limit
  emit('status', next)
}

async function load() {
  try {
    apply(await fetchMatrixInstanceStatus())
    loadError.value = false
  } catch (error) {
    debug.warn('matrix_bridge_instance_status failed:', error)
    loadError.value = true
  }
}

async function run(what: string, action: () => Promise<void>) {
  busy.value = true
  try {
    await action()
  } catch (error) {
    debug.error(`${what} failed:`, (error as { code?: unknown } | null)?.code ?? '')
    toast.error(t('matrixBridge.admin.saveFailed'))
  } finally {
    busy.value = false
  }
}

async function save() {
  if (!savable.value) return
  await run('matrix_bridge_instance_set', async () => {
    const account = form.connection === 'account'
    const next = await saveMatrixInstance({
      ...form,
      accessToken: account ? checkMatrixToken(form.accessToken).token : '',
    })
    downloaded.value = false
    const before = status.value
    if (next.connection === 'application_service' && before?.hasServiceTokens && REGISTERED.some((name) => next[name] !== before[name])) {
      registrationStale.value = true
    }
    apply(next)
    toast.success(t('matrixBridge.admin.saved'))
  })
}

/** The file goes to the browser's downloads; the page keeps none of it. */
async function makeRegistration() {
  asking.value = null
  downloaded.value = false
  await run('matrix_bridge_instance_registration', async () => {
    const text = `${JSON.stringify(await createMatrixRegistration(), null, 2)}\n`
    saveBlob(new Blob([text], { type: 'application/json' }), MATRIX_REGISTRATION_FILE)
    downloaded.value = true
    registrationStale.value = false
    await load()
  })
}

async function clear() {
  asking.value = null
  await run('matrix_bridge_instance_clear', async () => {
    await clearMatrixInstance()
    downloaded.value = false
    registrationStale.value = false
    await load()
    toast.success(t('matrixBridge.admin.cleared'))
  })
}

/** Saved on change; the switch returns to its previous position when the save fails. */
async function setEnabled(next: boolean) {
  enabled.value = next
  switching.value = true
  try {
    await saveBridgeInstanceConfig(MATRIX_INSTANCE_ENABLED_KEY, next)
    if (status.value) status.value = { ...status.value, enabled: next }
    toast.success(t('matrixBridge.admin.saved'))
  } catch (error) {
    enabled.value = !next
    debug.error('Saving the instance Matrix bridge switch failed:', error)
    toast.error(t('matrixBridge.admin.saveFailed'))
  } finally {
    switching.value = false
  }
}

async function saveLimit() {
  if (limitInvalid.value) return
  savingLimit.value = true
  try {
    await saveBridgeInstanceConfig(MATRIX_INSTANCE_LIMIT_KEY, limit.value)
    if (status.value) status.value = { ...status.value, limit: limit.value }
    toast.success(t('matrixBridge.admin.saved'))
  } catch (error) {
    debug.error('Saving the instance Matrix bridge limit failed:', error)
    toast.error(t('matrixBridge.admin.saveFailed'))
  } finally {
    savingLimit.value = false
  }
}

onMounted(load)
</script>

<style scoped src="../../admin/adminShared.css"></style>
<style scoped src="../discord-bridge/bridgeAdmin.css"></style>
<style scoped>
.field {
  max-width: 560px;
}

.credentials,
.registration {
  margin-bottom: 16px;
}

.registration .title {
  margin: 0 0 4px;
}

.registration .hint {
  margin: 0 0 8px;
}

.confirm {
  margin-bottom: 12px;
}

.connection-pick {
  margin: 0 0 12px;
  padding: 0;
  border: none;
  min-width: 0;
}

.connection-pick legend {
  padding: 0;
  margin-bottom: 4px;
}

.connection-option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 6px 0;
  color: var(--text-primary);
  cursor: pointer;
}

.connection-option input {
  margin-top: 4px;
  flex-shrink: 0;
}

.option-hint {
  display: block;
}

.login summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
}
</style>
