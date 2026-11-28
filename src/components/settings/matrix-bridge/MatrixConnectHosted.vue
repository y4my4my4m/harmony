<template>
  <form data-testid="matrix-connect-hosted" novalidate @input="clearIssue" @submit.prevent="submit">
    <p class="db-text">{{ t('matrixBridge.hosted.lead') }}</p>
    <div class="db-banner db-banner--warn" data-testid="matrix-hosted-access">
      <p>{{ t('matrixBridge.hosted.access') }}</p>
      <p>{{ t('matrixBridge.hosted.ownAccount') }}</p>
    </div>

    <div class="db-field hosted-field">
      <label class="db-label" :for="`${uid}-homeserver`">{{ t('matrixBridge.hosted.homeserver') }}</label>
      <input
        :id="`${uid}-homeserver`"
        v-model.trim="homeserver"
        class="db-input"
        type="text"
        inputmode="url"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        maxlength="255"
        placeholder="matrix.org"
        :disabled="busy"
        :aria-invalid="homeserverInvalid ? 'true' : undefined"
        :aria-describedby="`${uid}-homeserver-help`"
        data-testid="matrix-hosted-homeserver"
      />
      <p :id="`${uid}-homeserver-help`" :class="homeserverInvalid ? 'db-field-error' : 'db-muted field-help'" data-testid="matrix-hosted-homeserver-help">
        {{ t(homeserverInvalid ? 'matrixBridge.hosted.issue.address' : 'matrixBridge.hosted.homeserverHelp') }}
      </p>
    </div>

    <fieldset class="method-pick" :disabled="busy" data-testid="matrix-hosted-method">
      <legend class="db-label">{{ t('matrixBridge.hosted.method.label') }}</legend>
      <label v-for="m in METHODS" :key="m" class="method-option">
        <input v-model="method" type="radio" :name="`${uid}-method`" :value="m" :data-testid="`matrix-hosted-method-${m}`" />
        <span>{{ t(`matrixBridge.hosted.method.${m}`) }}</span>
      </label>
    </fieldset>

    <template v-if="method === 'password'">
      <div class="db-field hosted-field">
        <label class="db-label" :for="`${uid}-user`">{{ t('matrixBridge.hosted.user') }}</label>
        <input
          :id="`${uid}-user`"
          v-model.trim="user"
          class="db-input"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          data-1p-ignore
          data-lpignore="true"
          :disabled="busy"
          data-testid="matrix-hosted-user"
        />
      </div>
      <div class="db-field hosted-field">
        <label class="db-label" :for="`${uid}-password`">{{ t('matrixBridge.hosted.password') }}</label>
        <input
          :id="`${uid}-password`"
          v-model="password"
          class="db-input"
          type="password"
          autocomplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          :disabled="busy"
          :aria-describedby="`${uid}-password-help`"
          data-testid="matrix-hosted-password"
        />
        <p :id="`${uid}-password-help`" class="db-muted field-help" data-testid="matrix-hosted-password-help">{{ t('matrixBridge.hosted.passwordHelp') }}</p>
      </div>
    </template>

    <div v-else class="db-field hosted-field">
      <label class="db-label" :for="`${uid}-token`">{{ t('matrixBridge.hosted.token') }}</label>
      <input
        :id="`${uid}-token`"
        v-model="token"
        class="db-input token-input"
        type="password"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        data-1p-ignore
        data-lpignore="true"
        :disabled="busy"
        :aria-describedby="`${uid}-token-help`"
        data-testid="matrix-hosted-token"
      />
      <p :id="`${uid}-token-help`" class="db-muted field-help">{{ t('matrixBridge.self.copiedToken') }}</p>
    </div>

    <p v-if="issue" class="db-field-error form-issue" role="alert" data-testid="matrix-hosted-issue" :data-issue="issue">{{ issueText }}</p>
    <div v-if="saveError" class="db-banner db-banner--error" role="alert" data-testid="matrix-hosted-error">
      <p>{{ saveError }}</p>
    </div>
    <div v-if="saved" class="db-banner db-banner--success" role="status" data-testid="matrix-hosted-saved">
      <p>{{ t('matrixBridge.hosted.saved') }}</p>
    </div>

    <div class="db-actions">
      <button type="submit" class="btn btn-primary" :disabled="busy" data-testid="matrix-hosted-save">
        {{ t(busy ? `matrixBridge.hosted.busy.${method}` : `matrixBridge.hosted.save.${method}`) }}
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import type { MatrixBridgeState } from '@/utils/matrixBridgeSetup'
import {
  MatrixSignInError,
  checkMatrixToken,
  checkTokenWithHomeserver,
  homeserverOrigin,
  requirePasswordLogin,
  resolveClientApi,
  signInWithPassword,
  signOut,
  type MatrixSignInIssue,
  type MatrixTokenIssue,
} from '@/utils/matrixLogin'
import { matrixManagedErrorKey, setMatrixAccount } from './matrixManagedApi'

const METHODS = ['password', 'token'] as const

const props = defineProps<{
  bridgeId: string
  /** The homeserver of the account it has. */
  homeserverUrl?: string | null
}>()

const emit = defineEmits<{ saved: [state: MatrixBridgeState] }>()

const { t } = useI18n()
const uid = `matrix-hosted-${useId()}`

const homeserver = ref(props.homeserverUrl ?? '')
const method = ref<(typeof METHODS)[number]>('password')
const user = ref('')
const password = ref('')
const token = ref('')
const busy = ref(false)
const issue = ref<MatrixSignInIssue | MatrixTokenIssue | 'incomplete' | null>(null)
const retryAfter = ref(0)
const saveError = ref('')
const saved = ref(false)

const homeserverInvalid = computed(() => issue.value === 'address')
const issueText = computed(() => {
  if (!issue.value) return ''
  if (issue.value === 'limited' && retryAfter.value) return t('matrixBridge.hosted.issue.limitedFor', { count: retryAfter.value }, retryAfter.value)
  return t(`matrixBridge.hosted.issue.${issue.value}`)
})

function clearIssue() {
  issue.value = null
  saveError.value = ''
}

function show(error: unknown) {
  if (error instanceof MatrixSignInError) {
    issue.value = error.issue
    retryAfter.value = error.retryAfterSeconds
    return
  }
  debug.error('matrix_bridge_set_account failed:', (error as { code?: unknown } | null)?.code ?? '')
  saveError.value = t(matrixManagedErrorKey(error, 'matrixBridge.errors.account'))
}

async function save(origin: string, accessToken: string) {
  const state = await setMatrixAccount(props.bridgeId, origin, accessToken)
  token.value = ''
  saved.value = true
  emit('saved', state)
}

async function signIn(origin: string) {
  if (!user.value || !password.value) {
    issue.value = 'incomplete'
    return
  }
  const clientApi = await resolveClientApi(origin)
  try {
    await requirePasswordLogin(clientApi)
  } catch (error) {
    if (error instanceof MatrixSignInError && error.issue === 'no_password') method.value = 'token'
    throw error
  }
  const accessToken = await signInWithPassword(clientApi, user.value, password.value)
  try {
    await save(origin, accessToken)
  } catch (error) {
    await signOut(clientApi, accessToken)
    throw error
  }
}

async function pasteToken(origin: string) {
  const check = checkMatrixToken(token.value)
  if (check.issue) {
    issue.value = check.issue
    return
  }
  await checkTokenWithHomeserver(await resolveClientApi(origin), check.token)
  await save(origin, check.token)
}

async function submit() {
  if (busy.value) return
  clearIssue()
  saved.value = false
  const origin = homeserverOrigin(homeserver.value)
  if (!origin) {
    issue.value = 'address'
    return
  }
  busy.value = true
  try {
    await (method.value === 'password' ? signIn(origin) : pasteToken(origin))
  } catch (error) {
    show(error)
  } finally {
    password.value = ''
    busy.value = false
  }
}
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.hosted-field {
  max-width: 480px;
}

.field-help {
  margin: 0;
}

.token-input {
  font-family: var(--font-mono, ui-monospace, monospace);
}

.method-pick {
  margin: 0 0 12px;
  padding: 0;
  border: none;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
}

.method-pick legend {
  padding: 0;
  margin-bottom: 6px;
}

.method-option {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  min-height: 32px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
}

.form-issue {
  margin-bottom: 12px;
}
</style>
