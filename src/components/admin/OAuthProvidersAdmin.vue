<template>
  <section class="sip" :aria-labelledby="`${uid}-title`" data-testid="admin-oauth-providers">
    <h3 :id="`${uid}-title`" class="sip-title">{{ t('admin.signInProviders.title') }}</h3>
    <p class="sip-hint">{{ t('admin.signInProviders.lead') }}</p>

    <p v-if="loadFailed" class="sip-error" role="alert">{{ t('admin.signInProviders.loadFailed') }}</p>
    <p v-else-if="writerNote" class="sip-note" role="status" data-testid="sip-writer-note">{{ writerNote }}</p>

    <div class="sip-callback">
      <span :id="`${uid}-callback`" class="sip-hint">{{ t('admin.signInProviders.callback') }}</span>
      <div class="sip-callback-row">
        <code :aria-labelledby="`${uid}-callback`" data-testid="sip-callback">{{ callbackUrl }}</code>
        <button type="button" class="sip-btn sip-btn--secondary" @click="copyCallback">
          {{ t('admin.signInProviders.copy') }}
        </button>
      </div>
    </div>

    <ul class="sip-list">
      <li
        v-for="provider in BUILT_IN_OAUTH_PROVIDERS"
        :key="provider"
        class="sip-card"
        :data-testid="`sip-${provider}`"
      >
        <div class="sip-head">
          <span
            class="sip-icon"
            aria-hidden="true"
            :style="{ color: BUILT_IN_OAUTH_COLORS[provider] || 'var(--text-primary)' }"
            v-html="BUILT_IN_OAUTH_ICONS[provider]"
          ></span>
          <h4 :id="`${uid}-${provider}`" class="sip-name">{{ oauthProviderLabel(provider) }}</h4>
          <span class="sip-status" :class="`sip-status--${state(provider)}`" data-testid="sip-status">
            {{ t(`admin.signInProviders.status.${state(provider)}`) }}
          </span>
          <label class="sip-switch">
            <input
              type="checkbox"
              :checked="buttons.includes(provider)"
              :disabled="!loaded || busy !== null"
              :aria-label="t('admin.signInProviders.showButtonLabel', { provider: oauthProviderLabel(provider) })"
              data-testid="sip-button-toggle"
              @change="setButton(provider, ($event.target as HTMLInputElement).checked)"
            />
            <span class="sip-switch-track" aria-hidden="true"></span>
            <span>{{ t('admin.signInProviders.showButton') }}</span>
          </label>
        </div>

        <form class="sip-form" novalidate :aria-labelledby="`${uid}-${provider}`" @submit.prevent="save(provider)">
          <div class="sip-field">
            <label class="sip-label" :for="`${uid}-${provider}-id`">{{ t('admin.signInProviders.clientId') }}</label>
            <input
              :id="`${uid}-${provider}-id`"
              v-model="drafts[provider].clientId"
              class="sip-input"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              :inputmode="provider === 'discord' ? 'numeric' : undefined"
              :disabled="!loaded || busy !== null"
              :aria-invalid="problem[provider] === 'clientId' || problem[provider] === 'discordId' ? 'true' : undefined"
              data-testid="sip-client-id"
            />
          </div>
          <div class="sip-field">
            <label class="sip-label" :for="`${uid}-${provider}-secret`">{{ t('admin.signInProviders.secret') }}</label>
            <input
              :id="`${uid}-${provider}-secret`"
              v-model="drafts[provider].secret"
              class="sip-input"
              type="password"
              autocomplete="new-password"
              :placeholder="stored(provider)?.hasSecret ? t('admin.signInProviders.secretSaved') : ''"
              :disabled="!loaded || busy !== null"
              :aria-invalid="problem[provider] === 'secret' ? 'true' : undefined"
              data-testid="sip-secret"
            />
          </div>
          <p class="sip-hint sip-where">{{ t(`admin.signInProviders.where.${provider}`) }}</p>
          <p v-if="problem[provider]" class="sip-error" role="alert" data-testid="sip-problem">
            {{ t(`admin.signInProviders.problem.${problem[provider]}`) }}
          </p>
          <div class="sip-actions">
            <button
              type="submit"
              class="sip-btn"
              :disabled="!loaded || busy !== null || !dirty(provider)"
              data-testid="sip-save"
            >
              {{ busy === provider ? t('admin.signInProviders.saving') : t('admin.signInProviders.save') }}
            </button>
            <button
              v-if="hasCredentials(provider)"
              type="button"
              class="sip-btn sip-btn--danger"
              :disabled="!loaded || busy !== null"
              data-testid="sip-clear"
              @click="clear(provider)"
            >
              {{ t('admin.signInProviders.clear') }}
            </button>
          </div>
        </form>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { supabase } from '@/supabase'
import { adminService } from '@/services/AdminService'
import { useAuthStore } from '@/stores/auth'
import { runtimeConfig } from '@/services/runtimeConfig'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { debug } from '@/utils/debug'
import {
  BUILT_IN_OAUTH_PROVIDERS,
  oauthProviderLabel,
  type BuiltInOAuthProvider,
} from '@/utils/customOAuthProviders'
import { BUILT_IN_OAUTH_COLORS, BUILT_IN_OAUTH_ICONS } from '@/utils/oauthProviderIcons'
import {
  clearCredentials,
  credentialProblem,
  fetchCredentialsStatus,
  fetchSignInServiceProviders,
  parseButtonList,
  saveCredentials,
  type CredentialProblem,
  type CredentialsStatus,
  type ProviderCredentials,
} from '@/services/authProviderCredentials'

type State = 'active' | 'applying' | 'hidden' | 'server' | 'unset' | 'unknown'

/** GoTrue reloads 5 s after the file changes; the writer passes every 10 s. */
const SETTLE_POLL_MS = 2_000
const SETTLE_TIMEOUT_MS = 45_000

const { t, locale } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()
const uid = `sip-${useId()}`
const authStore = useAuthStore()

const status = ref<CredentialsStatus | null>(null)
const live = ref<Partial<Record<BuiltInOAuthProvider, boolean>> | null>(null)
const buttons = ref<BuiltInOAuthProvider[]>([])
const loaded = ref(false)
const loadFailed = ref(false)
const busy = ref<BuiltInOAuthProvider | 'buttons' | null>(null)
const drafts = reactive(
  Object.fromEntries(BUILT_IN_OAUTH_PROVIDERS.map((p) => [p, { clientId: '', secret: '' }])) as Record<
    BuiltInOAuthProvider,
    { clientId: string; secret: string }
  >,
)
const problem = reactive<Partial<Record<BuiltInOAuthProvider, CredentialProblem | null>>>({})
let settleTimer: ReturnType<typeof setTimeout> | null = null
let settleUntil = 0

const callbackUrl = `${(runtimeConfig.supabaseUrl || '').replace(/\/+$/, '')}/auth/v1/callback`

const stored = (provider: BuiltInOAuthProvider): ProviderCredentials | undefined => status.value?.providers[provider]
const hasCredentials = (provider: BuiltInOAuthProvider) => {
  const row = stored(provider)
  return !!row && (!!row.clientId || row.hasSecret)
}
const dirty = (provider: BuiltInOAuthProvider) => {
  const draft = drafts[provider]
  return draft.secret.trim() !== '' || draft.clientId.trim() !== (stored(provider)?.clientId ?? '')
}

function state(provider: BuiltInOAuthProvider): State {
  const running = live.value?.[provider]
  const row = stored(provider)
  const panel = !!row?.clientId && !!row?.hasSecret
  if (panel && !buttons.value.includes(provider)) return 'hidden'
  if (running === undefined) return 'unknown'
  if (panel) return running ? 'active' : 'applying'
  // A cleared row stays on in GoTrue until the writer's next pass reaches it.
  if (row) return running ? 'applying' : 'unset'
  return running ? 'server' : 'unset'
}

const writerNote = computed(() => {
  const writer = status.value?.writer
  if (!writer) return ''
  if (!writer.seenAt) return t('admin.signInProviders.writerOff')
  if (!writer.live) {
    const time = new Date(writer.seenAt).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
    return t('admin.signInProviders.writerStopped', { time })
  }
  if (writer.error) return t('admin.signInProviders.writerError', { error: writer.error })
  return ''
})

function applyStatus(next: CredentialsStatus) {
  status.value = next
  for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
    drafts[provider].clientId = next.providers[provider]?.clientId ?? ''
    drafts[provider].secret = ''
  }
}

async function readButtons(): Promise<BuiltInOAuthProvider[]> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'oauth_providers')
    .maybeSingle()
  if (error) throw error
  return parseButtonList(data?.config_value)
}

async function refreshLive() {
  live.value = await fetchSignInServiceProviders()
}

/** Polls the sign-in service until every provider leaves 'applying', or the timeout. */
function settle() {
  settleUntil = Date.now() + SETTLE_TIMEOUT_MS
  if (settleTimer) return
  const tick = async () => {
    settleTimer = null
    await refreshLive()
    const pending = BUILT_IN_OAUTH_PROVIDERS.some((p) => state(p) === 'applying')
    if (pending && Date.now() < settleUntil) settleTimer = setTimeout(tick, SETTLE_POLL_MS)
    else if (pending) status.value = await fetchCredentialsStatus().catch(() => status.value)
  }
  settleTimer = setTimeout(tick, SETTLE_POLL_MS)
}

async function save(provider: BuiltInOAuthProvider) {
  const draft = drafts[provider]
  const found = credentialProblem(provider, draft.clientId, draft.secret, stored(provider))
  problem[provider] = found
  if (found) return
  busy.value = provider
  try {
    applyStatus(await saveCredentials(provider, draft.clientId, draft.secret))
    toast.success(t('admin.signInProviders.saved', { provider: oauthProviderLabel(provider) }))
    settle()
  } catch (error) {
    debug.error('auth_provider_credentials_set failed:', error)
    toast.error(t('admin.signInProviders.saveFailed', { provider: oauthProviderLabel(provider) }))
  } finally {
    busy.value = null
  }
}

async function clear(provider: BuiltInOAuthProvider) {
  const name = oauthProviderLabel(provider)
  if (!(await confirm({
    title: t('admin.signInProviders.clearTitle', { provider: name }),
    message: t('admin.signInProviders.clearMessage', { provider: name }),
    confirmButtonText: t('admin.signInProviders.clear'),
    dangerAction: true,
  }))) return
  busy.value = provider
  try {
    applyStatus(await clearCredentials(provider))
    problem[provider] = null
    toast.success(t('admin.signInProviders.cleared', { provider: name }))
    settle()
  } catch (error) {
    debug.error('auth_provider_credentials_clear failed:', error)
    toast.error(t('admin.signInProviders.saveFailed', { provider: name }))
  } finally {
    busy.value = null
  }
}

async function setButton(provider: BuiltInOAuthProvider, on: boolean) {
  const previous = buttons.value
  const next = BUILT_IN_OAUTH_PROVIDERS.filter((p) => (p === provider ? on : previous.includes(p)))
  buttons.value = next
  busy.value = 'buttons'
  try {
    await adminService.setInstanceConfig('oauth_providers', next, authStore.session?.user?.id ?? '', 'Enabled OAuth providers')
    toast.success(t('admin.signInProviders.buttonsSaved'))
    if (hasCredentials(provider)) settle()
  } catch (error) {
    buttons.value = previous
    debug.error('Saving oauth_providers failed:', error)
    toast.error(t('admin.signInProviders.buttonsFailed'))
  } finally {
    busy.value = null
  }
}

async function copyCallback() {
  try {
    await navigator.clipboard.writeText(callbackUrl)
    toast.success(t('admin.signInProviders.copied'))
  } catch {
    toast.error(t('admin.signInProviders.copyFailed'))
  }
}

onMounted(async () => {
  try {
    const [next, list] = await Promise.all([fetchCredentialsStatus(), readButtons()])
    applyStatus(next)
    buttons.value = list
    loaded.value = true
  } catch (error) {
    debug.error('Sign-in provider settings load failed:', error)
    loadFailed.value = true
  }
  await refreshLive()
  if (BUILT_IN_OAUTH_PROVIDERS.some((p) => state(p) === 'applying')) settle()
})

onUnmounted(() => {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = null
})
</script>

<style scoped>
.sip {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.sip-title {
  margin: 0;
}

.sip-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.sip-note {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warning);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  line-height: 1.4;
}

.sip-error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--danger);
}

.sip-callback {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.sip-callback-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  min-width: 0;
}

.sip-callback-row code {
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--background-quinary);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
  min-width: 0;
}

.sip-list {
  display: grid;
  /* Four providers: two by two, never three and a lone fourth. */
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

@media (max-width: 900px) {
  .sip-list {
    grid-template-columns: minmax(0, 1fr);
  }
}

.sip-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  min-width: 0;
}

.sip-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.sip-icon {
  display: inline-flex;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
}

.sip-icon :deep(svg) {
  width: 100%;
  height: 100%;
}

.sip-name {
  margin: 0;
  font-size: var(--font-size-md, 1rem);
  font-weight: 600;
  color: var(--text-primary);
}

.sip-status {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 600;
  background: var(--background-quinary);
  color: var(--text-secondary);
}

.sip-status--active {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--text-primary);
}

.sip-status--applying {
  background: color-mix(in srgb, var(--warning) 18%, transparent);
  color: var(--text-primary);
}

.sip-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  cursor: pointer;
  position: relative;
}

.sip-switch input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
}

.sip-switch-track {
  position: relative;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--background-quinary);
  border: 1px solid var(--border-primary);
  transition: background 0.15s ease;
}

.sip-switch-track::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-secondary);
  transition: transform 0.15s ease;
}

.sip-switch input:checked + .sip-switch-track {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
}

.sip-switch input:checked + .sip-switch-track::before {
  transform: translateX(16px);
  background: var(--text-on-primary, #fff);
}

.sip-switch input:focus-visible + .sip-switch-track {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.sip-switch input:disabled + .sip-switch-track {
  opacity: 0.5;
}

.sip-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sip-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sip-label {
  margin: 0;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.sip-input {
  width: 100%;
  min-width: 0;
  background: var(--background-quinary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  padding: 8px 10px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
}

.sip-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.sip-input[aria-invalid='true'] {
  border-color: var(--danger);
}

.sip-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.sip-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
}

.sip-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sip-btn--secondary {
  background: var(--background-quinary);
  color: var(--text-primary);
}

.sip-btn--danger {
  background: transparent;
  color: var(--danger);
  border: 1px solid var(--danger);
}
</style>
