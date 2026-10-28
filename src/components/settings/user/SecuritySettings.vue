<template>
  <div class="security-settings">
    <div class="sec-header">
      <h2 class="sec-title">{{ $t('settings.security') }}</h2>
      <p class="sec-subtitle">{{ $t('security.subtitle') }}</p>
    </div>

    <section class="sec-card" aria-labelledby="password-title">
      <header class="sec-card-header">
        <div>
          <h3 id="password-title" class="sec-card-title">{{ hasPassword || providerManaged ? $t('auth.password') : $t('security.password.setTitle') }}</h3>
          <p
            v-if="providerManaged"
            ref="managedNote"
            class="sec-card-description"
            data-testid="password-provider-managed"
            tabindex="-1"
          >{{ $t('security.password.providerManaged', { providers: providerNames }) }}</p>
          <p v-else class="sec-card-description">
            <template v-if="hasPassword">{{ $t('security.password.changeDescription') }}</template>
            <template v-else>{{ $t('security.password.providerDescription', { providers: providerNames }) }}</template>
          </p>
        </div>
      </header>

      <form v-if="!providerManaged" class="sec-form" autocomplete="on" @submit.prevent="changePassword">
        <input type="email" class="sec-visually-hidden" autocomplete="username" :value="email" tabindex="-1" aria-hidden="true" readonly />
        <div v-if="hasPassword" class="sec-field">
          <label class="sec-label" for="current-password">{{ $t('auth.currentPassword') }}</label>
          <input
            id="current-password"
            ref="currentInput"
            v-model="currentPassword"
            class="sec-input"
            :class="{ 'has-error': errors.current }"
            type="password"
            autocomplete="current-password"
            :aria-invalid="!!errors.current || undefined"
            :aria-describedby="errors.current ? 'current-password-error' : undefined"
            @input="errors.current = ''"
          />
          <p v-if="errors.current" id="current-password-error" class="sec-error" role="alert">{{ errors.current }}</p>
        </div>
        <div class="sec-field">
          <label class="sec-label" for="new-password">{{ $t('auth.newPassword') }}</label>
          <input
            id="new-password"
            ref="nextInput"
            v-model="newPassword"
            class="sec-input"
            :class="{ 'has-error': errors.next }"
            type="password"
            autocomplete="new-password"
            minlength="8"
            :aria-invalid="!!errors.next || undefined"
            :aria-describedby="errors.next ? 'new-password-error' : 'new-password-hint'"
            @input="errors.next = ''"
          />
          <p v-if="errors.next" id="new-password-error" class="sec-error" role="alert">{{ errors.next }}</p>
          <p v-else id="new-password-hint" class="sec-hint">{{ $t('security.password.hint') }}</p>
        </div>
        <div class="sec-field">
          <label class="sec-label" for="confirm-password">{{ $t('auth.confirmNewPassword') }}</label>
          <input
            id="confirm-password"
            ref="confirmInput"
            v-model="confirmPassword"
            class="sec-input"
            :class="{ 'has-error': errors.confirm }"
            type="password"
            autocomplete="new-password"
            :aria-invalid="!!errors.confirm || undefined"
            :aria-describedby="errors.confirm ? 'confirm-password-error' : undefined"
            @input="errors.confirm = ''"
          />
          <p v-if="errors.confirm" id="confirm-password-error" class="sec-error" role="alert">{{ errors.confirm }}</p>
        </div>
        <div class="sec-actions sec-actions-start">
          <button
            type="submit"
            class="sec-btn sec-btn-primary"
            :disabled="!passwordFormReady"
            :aria-disabled="passwordBusy || undefined"
            :aria-busy="passwordBusy || undefined"
          >
            {{ passwordBusy ? $t('security.password.saving') : hasPassword ? $t('auth.changePassword') : $t('security.password.setPassword') }}
          </button>
        </div>
      </form>
    </section>

    <TwoFactorSettings @changed="sessionsPanel?.load()" />
    <SessionsPanel ref="sessionsPanel" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useToast } from 'vue-toastification'
import { useI18n } from 'vue-i18n'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'
import { debug } from '@/utils/debug'
import { accountSecurityService, securityErrorMessage } from '@/services/AccountSecurityService'
import { oauthProviderLabel, parseCustomOAuthProviders, type CustomOAuthProvider } from '@/utils/customOAuthProviders'
import { isProviderManagedError, knownProviderManaged, rememberProviderManaged } from '@/utils/providerManagedAccount'
import TwoFactorSettings from './TwoFactorSettings.vue'
import SessionsPanel from './SessionsPanel.vue'
import './securitySettings.css'

const toast = useToast()
const { t } = useI18n()
const authStore = useAuthStore()

const sessionsPanel = ref<InstanceType<typeof SessionsPanel> | null>(null)

const providers = computed<string[]>(() => {
  const list = authStore.session?.user?.app_metadata?.providers
  return Array.isArray(list) ? list : []
})
const hasPassword = computed(() => providers.value.length === 0 || providers.value.includes('email'))
const customProviders = ref<CustomOAuthProvider[]>([])
const providerNames = computed(() => providers.value
  .filter((p) => p !== 'email')
  .map((p) => oauthProviderLabel(p, customProviders.value))
  .join(', ') || t('security.password.externalProvider'))
const userId = computed(() => authStore.session?.user?.id ?? null)
const refusedHere = ref(false)
const providerManaged = computed(() => refusedHere.value || knownProviderManaged(userId.value))
const managedNote = ref<HTMLElement | null>(null)

onMounted(async () => {
  if (!providers.value.some((p) => p.startsWith('custom:'))) return
  const { data } = await supabase.from('instance_config').select('config_value')
    .eq('config_key', 'custom_oauth_providers').maybeSingle()
  customProviders.value = parseCustomOAuthProviders(data?.config_value)
})
const email = computed(() => authStore.session?.user?.email ?? '')

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordBusy = ref(false)
const errors = ref({ current: '', next: '', confirm: '' })
const currentInput = ref<HTMLInputElement | null>(null)
const nextInput = ref<HTMLInputElement | null>(null)
const confirmInput = ref<HTMLInputElement | null>(null)

async function focusFirstError() {
  await nextTick()
  const field = errors.value.current ? currentInput.value
    : errors.value.next ? nextInput.value
      : errors.value.confirm ? confirmInput.value
        : null
  field?.focus()
}

const passwordFormReady = computed(() =>
  (!hasPassword.value || currentPassword.value.length > 0) &&
  newPassword.value.length > 0 &&
  confirmPassword.value.length > 0)

/** The account signs in only through its provider: the form gives way to a note that says so. */
function showProviderManaged() {
  rememberProviderManaged(userId.value)
  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  refusedHere.value = true
  void nextTick(() => managedNote.value?.focus())
}

async function changePassword() {
  if (passwordBusy.value) return
  errors.value = { current: '', next: '', confirm: '' }
  if (newPassword.value.length < 8) {
    errors.value.next = t('security.password.errors.tooShort')
  } else if (newPassword.value !== confirmPassword.value) {
    errors.value.confirm = t('security.password.errors.mismatch')
  } else if (hasPassword.value && newPassword.value === currentPassword.value) {
    errors.value.next = t('security.password.errors.sameAsCurrent')
  }
  if (errors.value.next || errors.value.confirm) {
    void focusFirstError()
    return
  }

  passwordBusy.value = true
  try {
    if (hasPassword.value) {
      const ok = await accountSecurityService.verifyPassword(currentPassword.value)
      if (!ok) {
        errors.value.current = t('security.password.errors.wrongCurrent')
        return
      }
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword.value })
    if (error) {
      if (isProviderManagedError(error)) {
        showProviderManaged()
        return
      }
      if (/different from the old password|same/i.test(error.message)) {
        errors.value.next = t('security.password.errors.sameAsCurrent')
      } else if (/at least|weak|characters/i.test(error.message)) {
        errors.value.next = error.message
      } else {
        throw error
      }
      return
    }
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    toast.success(hasPassword.value
      ? t('security.password.changed')
      : t('security.password.set'))
    void sessionsPanel.value?.load()
  } catch (error) {
    debug.error('Password change failed:', error)
    toast.error(securityErrorMessage(error, t('security.password.changeFailed')))
  } finally {
    passwordBusy.value = false
    void focusFirstError()
  }
}
</script>
