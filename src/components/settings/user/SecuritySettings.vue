<template>
  <div class="security-settings">
    <div class="sec-header">
      <h2 class="sec-title">{{ $t('settings.security') }}</h2>
      <p class="sec-subtitle">{{ $t('security.subtitle') }}</p>
    </div>

    <section class="sec-card" aria-labelledby="password-title">
      <header class="sec-card-header">
        <div>
          <h3 id="password-title" class="sec-card-title">{{ hasPassword ? $t('auth.password') : $t('security.password.setTitle') }}</h3>
          <p class="sec-card-description">
            <template v-if="hasPassword">{{ $t('security.password.changeDescription') }}</template>
            <template v-else>{{ $t('security.password.providerDescription', { providers: providerNames }) }}</template>
          </p>
        </div>
      </header>

      <form class="sec-form" autocomplete="on" @submit.prevent="changePassword">
        <input type="email" class="sec-visually-hidden" autocomplete="username" :value="email" tabindex="-1" aria-hidden="true" readonly />
        <div v-if="hasPassword" class="sec-field">
          <label class="sec-label" for="current-password">{{ $t('auth.currentPassword') }}</label>
          <input
            id="current-password"
            v-model="currentPassword"
            class="sec-input"
            :class="{ 'has-error': errors.current }"
            type="password"
            autocomplete="current-password"
            @input="errors.current = ''"
          />
          <p v-if="errors.current" class="sec-error">{{ errors.current }}</p>
        </div>
        <div class="sec-field">
          <label class="sec-label" for="new-password">{{ $t('auth.newPassword') }}</label>
          <input
            id="new-password"
            v-model="newPassword"
            class="sec-input"
            :class="{ 'has-error': errors.next }"
            type="password"
            autocomplete="new-password"
            minlength="8"
            @input="errors.next = ''"
          />
          <p v-if="errors.next" class="sec-error">{{ errors.next }}</p>
          <p v-else class="sec-hint">{{ $t('security.password.hint') }}</p>
        </div>
        <div class="sec-field">
          <label class="sec-label" for="confirm-password">{{ $t('auth.confirmNewPassword') }}</label>
          <input
            id="confirm-password"
            v-model="confirmPassword"
            class="sec-input"
            :class="{ 'has-error': errors.confirm }"
            type="password"
            autocomplete="new-password"
            @input="errors.confirm = ''"
          />
          <p v-if="errors.confirm" class="sec-error">{{ errors.confirm }}</p>
        </div>
        <div class="sec-actions sec-actions-start">
          <button type="submit" class="sec-btn sec-btn-primary" :disabled="passwordBusy || !passwordFormReady">
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
import { computed, ref } from 'vue'
import { useToast } from 'vue-toastification'
import { useI18n } from 'vue-i18n'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'
import { debug } from '@/utils/debug'
import { accountSecurityService, securityErrorMessage } from '@/services/AccountSecurityService'
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
const providerNames = computed(() => providers.value
  .filter((p) => p !== 'email')
  .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
  .join(', ') || t('security.password.externalProvider'))
const email = computed(() => authStore.session?.user?.email ?? '')

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordBusy = ref(false)
const errors = ref({ current: '', next: '', confirm: '' })

const passwordFormReady = computed(() =>
  (!hasPassword.value || currentPassword.value.length > 0) &&
  newPassword.value.length > 0 &&
  confirmPassword.value.length > 0)

async function changePassword() {
  errors.value = { current: '', next: '', confirm: '' }
  if (newPassword.value.length < 8) {
    errors.value.next = t('security.password.errors.tooShort')
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    errors.value.confirm = t('security.password.errors.mismatch')
    return
  }
  if (hasPassword.value && newPassword.value === currentPassword.value) {
    errors.value.next = t('security.password.errors.sameAsCurrent')
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
  }
}
</script>
