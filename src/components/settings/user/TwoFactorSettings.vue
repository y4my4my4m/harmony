<template>
  <section class="sec-card" aria-labelledby="twofa-title">
    <header class="sec-card-header">
      <div>
        <h3 id="twofa-title" ref="titleEl" class="sec-card-title" tabindex="-1">{{ $t('auth.twoFactorAuth') }}</h3>
        <p class="sec-card-description">{{ $t('security.twoFactor.description') }}</p>
      </div>
      <span v-if="!loading" class="sec-badge" :class="enabled ? 'sec-badge-on' : 'sec-badge-off'">
        <Icon :name="enabled ? 'shield-check' : 'shield-off'" :size="14" />
        {{ enabled ? $t('security.twoFactor.on') : $t('security.twoFactor.off') }}
      </span>
    </header>

    <div v-if="loading" class="sec-muted">{{ $t('security.twoFactor.checking') }}</div>

    <!-- Off -->
    <div v-else-if="!enabled && step === 'idle'" class="sec-row">
      <p class="sec-muted">{{ $t('security.twoFactor.offDescription') }}</p>
      <button
        ref="setUpButton"
        type="button"
        class="sec-btn sec-btn-primary"
        :aria-disabled="busy || undefined"
        :aria-busy="busy || undefined"
        data-testid="twofa-setup"
        @click="startEnroll"
      >
        {{ $t('security.twoFactor.setUp') }}
      </button>
    </div>

    <!-- Enrolment -->
    <div v-else-if="step === 'scan' || step === 'verify'" class="sec-steps">
      <ol class="sec-stepper" :aria-label="$t('security.twoFactor.steps.label')">
        <li :class="{ active: step === 'scan', done: step === 'verify' }">{{ $t('security.twoFactor.steps.scan') }}</li>
        <li :class="{ active: step === 'verify' }">{{ $t('auth.verify') }}</li>
        <li>{{ $t('security.twoFactor.steps.saveCodes') }}</li>
      </ol>

      <div v-if="step === 'scan'" class="sec-step">
        <p ref="scanLead" class="sec-text" tabindex="-1">{{ $t('security.twoFactor.scanQr') }}</p>
        <div class="sec-qr">
          <img v-if="qrCodeDataUrl" :src="qrCodeDataUrl" :alt="$t('security.twoFactor.qrAlt')" />
          <span v-else class="sec-muted">{{ $t('security.twoFactor.generating') }}</span>
        </div>
        <p id="twofa-secret-lead" class="sec-text">{{ $t('security.twoFactor.manualKey') }}</p>
        <div class="sec-secret" role="group" aria-labelledby="twofa-secret-label" aria-describedby="twofa-secret-lead">
          <span id="twofa-secret-label" class="sr-only">{{ $t('security.twoFactor.setupKey') }}</span>
          <code data-testid="twofa-secret">{{ formattedSecret }}</code>
          <button
            type="button"
            class="sec-icon-btn"
            :aria-label="$t('security.twoFactor.copySetupKey')"
            :title="$t('security.twoFactor.copySetupKey')"
            @click="copyText(totpSecret, $t('security.twoFactor.setupKeyCopied'))"
          >
            <Icon name="copy" :size="16" aria-hidden="true" />
          </button>
        </div>
        <div class="sec-actions">
          <button type="button" class="sec-btn sec-btn-secondary" @click="cancelEnroll">{{ $t('common.cancel') }}</button>
          <button type="button" class="sec-btn sec-btn-primary" :disabled="!totpSecret" @click="goToVerify">{{ $t('common.next') }}</button>
        </div>
      </div>

      <form v-else class="sec-step" @submit.prevent="verifyEnroll">
        <label class="sec-label" for="twofa-enroll-code">{{ $t('security.twoFactor.enterEnrollCode') }}</label>
        <input
          id="twofa-enroll-code"
          ref="enrollInput"
          v-model="enrollCode"
          class="sec-input sec-code-input"
          :class="{ 'has-error': enrollError }"
          inputmode="numeric"
          pattern="[0-9]*"
          autocomplete="one-time-code"
          maxlength="6"
          placeholder="000000"
          :aria-invalid="!!enrollError || undefined"
          :aria-describedby="enrollError ? 'twofa-enroll-error' : undefined"
          data-testid="twofa-enroll-code"
          @input="onEnrollInput"
        />
        <p v-if="enrollError" id="twofa-enroll-error" class="sec-error" role="alert">{{ enrollError }}</p>
        <div class="sec-actions">
          <button type="button" class="sec-btn sec-btn-secondary" :disabled="busy" @click="backToScan">{{ $t('common.back') }}</button>
          <button
            type="submit"
            class="sec-btn sec-btn-primary"
            :disabled="enrollCode.length !== 6"
            :aria-disabled="busy || undefined"
            :aria-busy="busy || undefined"
          >
            {{ busy ? $t('security.twoFactor.verifying') : $t('security.twoFactor.turnOn') }}
          </button>
        </div>
      </form>
    </div>

    <!-- Codes shown once -->
    <div v-else-if="step === 'codes'" class="sec-step">
      <div ref="codesCallout" class="sec-callout" tabindex="-1">
        <Icon name="alert-triangle" :size="16" aria-hidden="true" />
        <span>{{ $t('security.twoFactor.saveCodesWarning') }}</span>
      </div>
      <ul class="sec-codes" :aria-label="$t('security.twoFactor.recoveryCodes')">
        <li v-for="code in recoveryCodes" :key="code"><code>{{ code }}</code></li>
      </ul>
      <div class="sec-actions sec-actions-start">
        <button type="button" class="sec-btn sec-btn-secondary" @click="copyText(recoveryCodes.join('\n'), $t('security.twoFactor.recoveryCodesCopied'))">
          <Icon name="copy" :size="14" aria-hidden="true" /> {{ $t('security.twoFactor.copyCodes') }}
        </button>
        <button type="button" class="sec-btn sec-btn-secondary" @click="downloadCodes">
          <Icon name="download" :size="14" aria-hidden="true" /> {{ $t('security.twoFactor.downloadTxt') }}
        </button>
      </div>
      <label class="sec-check">
        <input v-model="codesSaved" type="checkbox" />
        {{ $t('security.twoFactor.codesSavedCheck') }}
      </label>
      <div class="sec-actions">
        <button type="button" class="sec-btn sec-btn-primary" :disabled="!codesSaved" @click="finishCodes">{{ $t('common.done') }}</button>
      </div>
    </div>

    <!-- On -->
    <div v-else class="sec-rows">
      <div class="sec-row">
        <div>
          <div class="sec-row-title">{{ $t('security.twoFactor.recoveryCodes') }}</div>
          <div class="sec-muted" :class="{ 'sec-warn': recoveryRemaining !== null && recoveryRemaining <= 3 }">
            <template v-if="recoveryRemaining === null">{{ $t('security.twoFactor.unavailable') }}</template>
            <template v-else-if="recoveryRemaining === 0">{{ $t('security.twoFactor.noneLeft') }}</template>
            <template v-else>{{ $t('security.twoFactor.remaining', { remaining: recoveryRemaining, total: recoveryTotal }) }}</template>
          </div>
        </div>
        <button type="button" class="sec-btn sec-btn-secondary" :disabled="busy" data-testid="twofa-regenerate" @click="openCodeModal('regenerate')">
          {{ $t('security.twoFactor.generateNew') }}
        </button>
      </div>
      <div class="sec-row">
        <div>
          <div class="sec-row-title">{{ $t('security.twoFactor.turnOffTitle') }}</div>
          <div class="sec-muted">{{ $t('security.twoFactor.turnOffDescription') }}</div>
        </div>
        <button type="button" class="sec-btn sec-btn-danger" :disabled="busy" data-testid="twofa-disable" @click="openCodeModal('disable')">{{ $t('security.twoFactor.turnOff') }}</button>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="codeModal" class="sec-modal-overlay" @click.self="closeCodeModal">
        <form
          ref="modalEl"
          class="sec-modal"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="modalTitleId"
          :aria-describedby="`${modalTitleId}-text`"
          tabindex="-1"
          data-testid="twofa-code-modal"
          @submit.prevent="submitCodeModal"
        >
          <h3 :id="modalTitleId" class="sec-modal-title">
            {{ codeModal === 'disable' ? $t('security.twoFactor.disableModal.title') : $t('security.twoFactor.regenerateModal.title') }}
          </h3>
          <p :id="`${modalTitleId}-text`" class="sec-text">
            <template v-if="codeModal === 'disable'">
              {{ useRecoveryCode ? $t('security.twoFactor.disableModal.textRecovery') : $t('security.twoFactor.disableModal.textTotp') }}
            </template>
            <template v-else>
              {{ $t('security.twoFactor.regenerateModal.text') }}
            </template>
          </p>
          <label class="sec-label" for="twofa-modal-code">
            {{ useRecoveryCode ? $t('auth.recoveryCode') : $t('auth.verificationCode') }}
          </label>
          <input
            id="twofa-modal-code"
            ref="modalInput"
            v-model="modalCode"
            class="sec-input"
            :class="{ 'sec-code-input': !useRecoveryCode, 'has-error': modalError }"
            :inputmode="useRecoveryCode ? 'text' : 'numeric'"
            :pattern="useRecoveryCode ? undefined : '[0-9]*'"
            :maxlength="useRecoveryCode ? RECOVERY_CODE_MAX_LENGTH : 6"
            :placeholder="useRecoveryCode ? RECOVERY_CODE_PLACEHOLDER : '000000'"
            autocomplete="one-time-code"
            autocapitalize="characters"
            spellcheck="false"
            :aria-invalid="!!modalError || undefined"
            :aria-describedby="modalError ? 'twofa-modal-error' : undefined"
            data-testid="twofa-modal-code"
            @input="onModalInput"
          />
          <p v-if="modalError" id="twofa-modal-error" class="sec-error" role="alert">{{ modalError }}</p>
          <button
            v-if="codeModal === 'disable'"
            type="button"
            class="sec-link"
            @click="toggleRecoveryMode"
          >
            {{ useRecoveryCode ? $t('security.twoFactor.useAuthenticator') : $t('security.twoFactor.useRecoveryCode') }}
          </button>
          <div class="sec-actions">
            <button type="button" class="sec-btn sec-btn-secondary" :disabled="busy" @click="closeCodeModal">{{ $t('common.cancel') }}</button>
            <button
              type="submit"
              class="sec-btn"
              :class="codeModal === 'disable' ? 'sec-btn-danger' : 'sec-btn-primary'"
              :disabled="!modalCodeValid"
              :aria-disabled="busy || undefined"
              :aria-busy="busy || undefined"
            >
              {{ busy ? $t('security.twoFactor.working') : codeModal === 'disable' ? $t('security.twoFactor.turnOff') : $t('security.twoFactor.generate') }}
            </button>
          </div>
        </form>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import './securitySettings.css'
import { computed, nextTick, onMounted, ref } from 'vue'
import { useToast } from 'vue-toastification'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import Icon from '@/components/common/Icon.vue'
import { useDialog } from '@/composables/useDialog'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'
import { debug } from '@/utils/debug'
import {
  RECOVERY_CODE_MAX_LENGTH,
  RECOVERY_CODE_MIN_LENGTH,
  RECOVERY_CODE_PLACEHOLDER,
  recoveryCodeLength,
} from '@/utils/mfaConstants'
import {
  accountSecurityService,
  recoveryCodesText,
  saveBlob,
  securityErrorMessage,
} from '@/services/AccountSecurityService'

const emit = defineEmits<{ changed: [] }>()

type Step = 'idle' | 'scan' | 'verify' | 'codes'
type CodeModal = 'disable' | 'regenerate' | null

const toast = useToast()
const { t } = useI18n()
const authStore = useAuthStore()
const { polite } = useAnnouncer()

const loading = ref(true)
const busy = ref(false)
const enabled = ref(false)
const factorId = ref('')
const step = ref<Step>('idle')

const totpSecret = ref('')
const qrCodeDataUrl = ref('')
const enrollCode = ref('')
const enrollError = ref('')
const enrollInput = ref<HTMLInputElement | null>(null)

const recoveryCodes = ref<string[]>([])
const codesSaved = ref(false)
const recoveryRemaining = ref<number | null>(null)
const recoveryTotal = ref(0)

const codeModal = ref<CodeModal>(null)
const modalCode = ref('')
const modalError = ref('')
const useRecoveryCode = ref(false)
const modalInput = ref<HTMLInputElement | null>(null)
const modalEl = ref<HTMLElement | null>(null)

const titleEl = ref<HTMLElement | null>(null)
const setUpButton = ref<HTMLButtonElement | null>(null)
const scanLead = ref<HTMLElement | null>(null)
const codesCallout = ref<HTMLElement | null>(null)

const { titleId: modalTitleId } = useDialog({
  open: () => codeModal.value !== null,
  element: modalEl,
  onClose: () => closeCodeModal(),
  // The opener unmounts when the modal leads to the recovery codes step.
  returnFocus: () => codesCallout.value ?? titleEl.value,
})

/** Each step replaces the control that led to it; focus moves to the new step. */
async function focusAfterStep(target: () => HTMLElement | null | undefined) {
  await nextTick()
  ;(target() ?? titleEl.value)?.focus()
}

const formattedSecret = computed(() => totpSecret.value.replace(/(.{4})/g, '$1 ').trim())

const modalCodeValid = computed(() => useRecoveryCode.value
  ? recoveryCodeLength(modalCode.value) >= RECOVERY_CODE_MIN_LENGTH
  : /^\d{6}$/.test(modalCode.value))

async function refresh() {
  try {
    const { data, error } = await supabase.auth.mfa.listFactors()
    if (error) throw error
    const verified = (data?.totp ?? []).find((f) => f.status === 'verified')
    enabled.value = !!verified
    factorId.value = verified?.id ?? ''
    if (enabled.value) {
      const status = await accountSecurityService.getRecoveryStatus()
      recoveryRemaining.value = status.remaining
      recoveryTotal.value = status.total
    } else {
      recoveryRemaining.value = null
    }
  } catch (error) {
    debug.error('2FA status check failed:', error)
    toast.error(securityErrorMessage(error, t('security.twoFactor.errors.statusFailed')))
  } finally {
    loading.value = false
  }
}

/** Unverified factors are abandoned enrolments; GoTrue caps how many may exist. */
async function removeUnverifiedFactors() {
  const { data } = await supabase.auth.mfa.listFactors()
  const stale = (data?.all ?? []).filter((f) => f.factor_type === 'totp' && f.status !== 'verified')
  for (const factor of stale) {
    await supabase.auth.mfa.unenroll({ factorId: factor.id }).catch(() => {})
  }
}

async function startEnroll() {
  if (busy.value) return
  busy.value = true
  try {
    await removeUnverifiedFactors()
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `Authenticator ${new Date().toISOString().slice(0, 16)}`,
    })
    if (error) throw error
    factorId.value = data.id
    totpSecret.value = data.totp.secret
    qrCodeDataUrl.value = await QRCode.toDataURL(data.totp.uri, { width: 224, margin: 2 })
    enrollCode.value = ''
    enrollError.value = ''
    step.value = 'scan'
    void focusAfterStep(() => scanLead.value)
  } catch (error) {
    debug.error('2FA enrolment failed:', error)
    toast.error(securityErrorMessage(error, t('security.twoFactor.errors.setupFailed')))
  } finally {
    busy.value = false
  }
}

async function goToVerify() {
  step.value = 'verify'
  await nextTick()
  enrollInput.value?.focus()
}

function backToScan() {
  step.value = 'scan'
  void focusAfterStep(() => scanLead.value)
}

function onEnrollInput() {
  enrollError.value = ''
  enrollCode.value = enrollCode.value.replace(/\D/g, '').slice(0, 6)
  if (enrollCode.value.length === 6 && !busy.value) void verifyEnroll()
}

async function verifyEnroll() {
  if (busy.value || !/^\d{6}$/.test(enrollCode.value)) return
  busy.value = true
  enrollError.value = ''
  try {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factorId.value, code: enrollCode.value })
    if (error) throw error
    // Verification raised this session to aal2 with a fresh TOTP step-up; GoTrue signed
    // out the account's other (aal1) sessions.
    recoveryCodes.value = await accountSecurityService.generateRecoveryCodes()
    codesSaved.value = false
    enabled.value = true
    step.value = 'codes'
    polite(t('security.twoFactor.enabledAnnouncement'))
    void focusAfterStep(() => codesCallout.value)
    emit('changed')
  } catch (error) {
    debug.error('2FA verification failed:', error)
    enrollError.value = securityErrorMessage(error, t('security.mfa.verificationFailed'))
    enrollCode.value = ''
    void focusAfterStep(() => enrollInput.value)
  } finally {
    busy.value = false
  }
}

async function cancelEnroll() {
  const id = factorId.value
  step.value = 'idle'
  totpSecret.value = ''
  qrCodeDataUrl.value = ''
  void focusAfterStep(() => setUpButton.value)
  if (id) await supabase.auth.mfa.unenroll({ factorId: id }).catch(() => {})
  factorId.value = ''
}

async function finishCodes() {
  recoveryCodes.value = []
  step.value = 'idle'
  totpSecret.value = ''
  qrCodeDataUrl.value = ''
  await refresh()
  void focusAfterStep(() => titleEl.value)
}

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(done)
  } catch {
    toast.error(t('security.twoFactor.errors.copyFailed'))
  }
}

function downloadCodes() {
  const account = authStore.session?.user?.email ?? 'Harmony account'
  const blob = new Blob([recoveryCodesText(recoveryCodes.value, account)], { type: 'text/plain' })
  saveBlob(blob, 'harmony-recovery-codes.txt')
}

async function openCodeModal(kind: Exclude<CodeModal, null>) {
  codeModal.value = kind
  modalCode.value = ''
  modalError.value = ''
  useRecoveryCode.value = false
  await nextTick()
  modalInput.value?.focus()
}

function closeCodeModal() {
  if (busy.value) return
  codeModal.value = null
}

function toggleRecoveryMode() {
  useRecoveryCode.value = !useRecoveryCode.value
  modalCode.value = ''
  modalError.value = ''
  modalInput.value?.focus()
}

function onModalInput() {
  modalError.value = ''
  if (useRecoveryCode.value) {
    modalCode.value = modalCode.value.toUpperCase()
  } else {
    modalCode.value = modalCode.value.replace(/\D/g, '').slice(0, 6)
  }
}

async function submitCodeModal() {
  if (!modalCodeValid.value || busy.value) return
  busy.value = true
  modalError.value = ''
  try {
    if (codeModal.value === 'regenerate') {
      await accountSecurityService.stepUpWithTotp(modalCode.value)
      recoveryCodes.value = await accountSecurityService.generateRecoveryCodes()
      codesSaved.value = false
      codeModal.value = null
      step.value = 'codes'
      polite(t('security.twoFactor.newCodesAnnouncement'))
      return
    }

    if (useRecoveryCode.value) {
      const userId = authStore.session?.user?.id
      const { data: valid, error } = await supabase.rpc('verify_recovery_code', {
        p_user_id: userId,
        p_code: modalCode.value,
      })
      if (error) throw error
      if (!valid) throw new Error(t('security.mfa.recoveryCodeInvalid'))
    } else {
      await accountSecurityService.stepUpWithTotp(modalCode.value)
    }
    // The factor trigger removes the recovery codes with the last verified factor.
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: factorId.value })
    if (unenrollError) throw unenrollError
    codeModal.value = null
    toast.success(t('security.twoFactor.disabledToast'))
    emit('changed')
    await refresh()
    void focusAfterStep(() => setUpButton.value)
  } catch (error) {
    debug.error('2FA action failed:', error)
    modalError.value = securityErrorMessage(error, t('security.twoFactor.errors.actionFailed'))
    if (!useRecoveryCode.value) modalCode.value = ''
    void focusAfterStep(() => modalInput.value)
  } finally {
    busy.value = false
  }
}

onMounted(refresh)
</script>
