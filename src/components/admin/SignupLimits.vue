<template>
  <section class="sl-card" :aria-labelledby="`${uid}-title`" data-testid="signup-limits">
    <h3 :id="`${uid}-title`" class="sl-title">{{ t('adminSignupLimits.title') }}</h3>
    <p class="sl-hint">{{ t('adminSignupLimits.intro') }}</p>
    <p class="sl-hint">{{ t('adminSignupLimits.hookNote') }}</p>
    <p class="sl-hint">
      <router-link :to="{ query: { tab: 'signups' } }" data-testid="signup-limits-review-link">{{ t('adminSignups.title') }}</router-link>
    </p>

    <p v-if="loadError" class="sl-error" role="alert">{{ loadError }}</p>

    <form v-else-if="form" class="sl-form" novalidate @submit.prevent="save">
      <label class="sl-check">
        <input v-model="form.enabled" type="checkbox" data-testid="signup-limits-enabled" />
        <span>{{ t('adminSignupLimits.enabled') }}</span>
      </label>

      <label class="sl-label" :for="`${uid}-ip`">{{ t('adminSignupLimits.ipCap') }}</label>
      <input
        :id="`${uid}-ip`"
        v-model="form.ipCap"
        class="sl-input sl-number"
        type="number"
        inputmode="numeric"
        min="0"
        :max="SIGNUP_CAP_MAX"
        step="1"
        :disabled="!form.enabled"
        :aria-invalid="capError === 'ip' ? 'true' : undefined"
        :aria-describedby="`${uid}-ip-hint`"
        data-testid="signup-limits-ip-cap"
      />
      <span :id="`${uid}-ip-hint`" class="sl-hint">{{ t('adminSignupLimits.ipCapHint') }}</span>

      <label class="sl-label" :for="`${uid}-mailbox`">{{ t('adminSignupLimits.mailboxCap') }}</label>
      <input
        :id="`${uid}-mailbox`"
        v-model="form.mailboxCap"
        class="sl-input sl-number"
        type="number"
        inputmode="numeric"
        min="0"
        :max="SIGNUP_CAP_MAX"
        step="1"
        :disabled="!form.enabled"
        :aria-invalid="capError === 'mailbox' ? 'true' : undefined"
        :aria-describedby="`${uid}-mailbox-hint`"
        data-testid="signup-limits-mailbox-cap"
      />
      <span :id="`${uid}-mailbox-hint`" class="sl-hint">{{ t('adminSignupLimits.mailboxCapHint') }}</span>

      <label class="sl-label" :for="`${uid}-domain`">{{ t('adminSignupLimits.domainCap') }}</label>
      <input
        :id="`${uid}-domain`"
        v-model="form.domainCap"
        class="sl-input sl-number"
        type="number"
        inputmode="numeric"
        min="0"
        :max="SIGNUP_CAP_MAX"
        step="1"
        :disabled="!form.enabled"
        :aria-invalid="capError === 'domain' ? 'true' : undefined"
        :aria-describedby="`${uid}-domain-hint`"
        data-testid="signup-limits-domain-cap"
      />
      <span :id="`${uid}-domain-hint`" class="sl-hint">{{ t('adminSignupLimits.domainCapHint') }}</span>

      <label class="sl-check">
        <input
          v-model="form.enforceCaps"
          type="checkbox"
          :disabled="!form.enabled"
          :aria-describedby="`${uid}-enforce-hint`"
          data-testid="signup-limits-enforce"
        />
        <span>{{ t('adminSignupLimits.enforceCaps') }}</span>
      </label>
      <span :id="`${uid}-enforce-hint`" class="sl-hint">{{ t('adminSignupLimits.enforceCapsHint') }}</span>

      <label class="sl-check">
        <input
          v-model="form.blockDisposable"
          type="checkbox"
          :disabled="!form.enabled"
          :aria-describedby="`${uid}-disposable-hint`"
          data-testid="signup-limits-disposable"
        />
        <span>{{ t('adminSignupLimits.blockDisposable') }}</span>
      </label>
      <span :id="`${uid}-disposable-hint`" class="sl-hint">{{ t('adminSignupLimits.blockDisposableHint') }}</span>

      <label class="sl-label" :for="`${uid}-domains`">{{ t('adminSignupLimits.blockedDomains') }}</label>
      <textarea
        :id="`${uid}-domains`"
        v-model="form.blockedDomains"
        class="sl-input"
        rows="3"
        autocapitalize="off"
        spellcheck="false"
        :disabled="!form.enabled"
        :aria-invalid="domainError ? 'true' : undefined"
        :aria-describedby="`${uid}-domains-hint`"
        data-testid="signup-limits-domains"
      />
      <span :id="`${uid}-domains-hint`" class="sl-hint">{{ t('adminSignupLimits.blockedDomainsHint') }}</span>

      <p class="sl-error" role="alert" data-testid="signup-limits-error">{{ formError }}</p>
      <div>
        <button type="submit" class="sl-btn" :disabled="saving || !changed" data-testid="signup-limits-save">
          {{ t('adminSignupLimits.save') }}
        </button>
      </div>
    </form>

    <div v-if="refusals" class="sl-refusals" data-testid="signup-limits-refusals">
      <h4 class="sl-label">{{ t('adminSignupLimits.wouldRefuseTitle') }}</h4>
      <dl>
        <div>
          <dt>{{ t('adminSignupLimits.refusalIpCap') }}</dt>
          <dd data-testid="signup-would-refuse-ip-cap">{{ refusals.wouldRefuse.ip_cap }}</dd>
        </div>
        <div>
          <dt>{{ t('adminSignupLimits.refusalDomainCap') }}</dt>
          <dd data-testid="signup-would-refuse-domain-cap">{{ refusals.wouldRefuse.domain_cap }}</dd>
        </div>
      </dl>
      <h4 class="sl-label">{{ t('adminSignupLimits.refusalsTitle') }}</h4>
      <dl>
        <div>
          <dt>{{ t('adminSignupLimits.refusalIpCap') }}</dt>
          <dd data-testid="signup-refusals-ip-cap">{{ refusals.refused.ip_cap }}</dd>
        </div>
        <div>
          <dt>{{ t('adminSignupLimits.refusalDomainCap') }}</dt>
          <dd data-testid="signup-refusals-domain-cap">{{ refusals.refused.domain_cap }}</dd>
        </div>
        <div>
          <dt>{{ t('adminSignupLimits.refusalMailboxCap') }}</dt>
          <dd data-testid="signup-refusals-mailbox-cap">{{ refusals.refused.mailbox_cap }}</dd>
        </div>
        <div>
          <dt>{{ t('adminSignupLimits.refusalBlockedDomain') }}</dt>
          <dd data-testid="signup-refusals-blocked-domain">{{ refusals.refused.blocked_domain }}</dd>
        </div>
      </dl>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useAuthStore } from '@/stores/auth'
import {
  loadSignupLimits,
  loadSignupRefusals,
  saveSignupLimits,
  type SignupLimits,
  type SignupRefusals,
} from '@/services/SignupLimitsService'
import { parseBlockedDomains, parseSignupCap, SIGNUP_CAP_MAX } from '@/utils/signupLimits'
import { debug } from '@/utils/debug'

interface Form {
  enabled: boolean
  ipCap: string | number
  mailboxCap: string | number
  domainCap: string | number
  enforceCaps: boolean
  blockDisposable: boolean
  blockedDomains: string
}

const { t } = useI18n()
const toast = useToast()
const authStore = useAuthStore()
const uid = useId()

const saved = ref<SignupLimits | null>(null)
const form = ref<Form | null>(null)
const refusals = ref<SignupRefusals | null>(null)
const loadError = ref('')
const formError = ref('')
const capError = ref<'ip' | 'mailbox' | 'domain' | null>(null)
const domainError = ref(false)
const saving = ref(false)

function toForm(limits: SignupLimits): Form {
  return { ...limits, blockedDomains: limits.blockedDomains.join('\n') }
}

const changed = computed(() => {
  if (!form.value || !saved.value) return false
  return JSON.stringify(form.value) !== JSON.stringify(toForm(saved.value))
})

async function save() {
  if (!form.value || !saved.value || saving.value) return
  formError.value = ''
  capError.value = null
  domainError.value = false

  const ipCap = parseSignupCap(form.value.ipCap)
  const mailboxCap = parseSignupCap(form.value.mailboxCap)
  const domainCap = parseSignupCap(form.value.domainCap)
  if (ipCap === null || mailboxCap === null || domainCap === null) {
    capError.value = ipCap === null ? 'ip' : mailboxCap === null ? 'mailbox' : 'domain'
    formError.value = t('adminSignupLimits.invalidCap')
    return
  }
  const { domains, invalid } = parseBlockedDomains(form.value.blockedDomains)
  if (invalid !== null) {
    domainError.value = true
    formError.value = t('adminSignupLimits.invalidDomain', { domain: invalid })
    return
  }

  const next: SignupLimits = {
    enabled: form.value.enabled,
    ipCap,
    mailboxCap,
    domainCap,
    enforceCaps: form.value.enforceCaps,
    blockDisposable: form.value.blockDisposable,
    blockedDomains: domains,
  }
  saving.value = true
  try {
    await saveSignupLimits(next, saved.value, authStore.session?.user?.id ?? '')
    saved.value = next
    form.value = toForm(next)
    toast.success(t('adminSignupLimits.saved'))
  } catch (error) {
    debug.error('Saving sign-up limits failed:', error)
    formError.value = t('adminSignupLimits.saveFailed')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    const limits = await loadSignupLimits()
    saved.value = limits
    form.value = toForm(limits)
  } catch (error) {
    debug.error('Loading sign-up limits failed:', error)
    loadError.value = t('adminSignupLimits.loadFailed')
    return
  }
  try {
    refusals.value = await loadSignupRefusals()
  } catch (error) {
    debug.warn('Loading sign-up refusals failed:', error)
  }
})
</script>

<style scoped>
.sl-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  min-width: 0;
}

.sl-title {
  margin: 0;
  font-size: var(--font-size-md, 1rem);
  font-weight: 600;
  color: var(--text-primary);
}

.sl-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.sl-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 480px;
}

.sl-label {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.sl-input {
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

.sl-number {
  max-width: 120px;
}

.sl-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.sl-input[aria-invalid='true'] {
  border-color: var(--danger);
}

.sl-input:disabled {
  opacity: 0.6;
}

.sl-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.sl-check:has(input:disabled) {
  color: var(--text-muted);
}

.sl-error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--danger);
}

.sl-error:empty {
  display: none;
}

.sl-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
}

.sl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sl-refusals dl {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin: var(--space-2) 0 var(--space-3);
}

.sl-refusals dt {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.sl-refusals dd {
  margin: 0;
  font-size: var(--font-size-md, 1rem);
  font-weight: 600;
  color: var(--text-primary);
}
</style>
