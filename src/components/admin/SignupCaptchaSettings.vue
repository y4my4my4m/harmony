<template>
  <section class="sc-card" :aria-labelledby="`${uid}-title`" data-testid="signup-captcha-settings">
    <h3 :id="`${uid}-title`" class="sc-title">{{ t('adminSignupCaptcha.title') }}</h3>
    <p class="sc-hint">{{ t('adminSignupCaptcha.intro') }}</p>

    <p v-if="loadError" class="sc-error" role="alert">{{ loadError }}</p>

    <form v-else-if="form" class="sc-form" novalidate @submit.prevent="save">
      <label class="sc-label" :for="`${uid}-provider`">{{ t('adminSignupCaptcha.provider') }}</label>
      <select :id="`${uid}-provider`" v-model="form.provider" class="sc-input" data-testid="signup-captcha-provider">
        <option value="off">{{ t('adminSignupCaptcha.providerOff') }}</option>
        <option value="turnstile">Cloudflare Turnstile</option>
        <option value="hcaptcha">hCaptcha</option>
      </select>
      <span class="sc-hint">{{ t('adminSignupCaptcha.providerHint', { origin: pageOrigin }) }}</span>

      <template v-if="form.provider !== 'off'">
        <label class="sc-label" :for="`${uid}-site`">{{ t('adminSignupCaptcha.siteKey') }}</label>
        <input
          :id="`${uid}-site`"
          v-model="form.siteKey"
          class="sc-input"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :aria-invalid="fieldError === 'site' ? 'true' : undefined"
          data-testid="signup-captcha-site-key"
        />

        <label class="sc-label" :for="`${uid}-secret`">{{ t('adminSignupCaptcha.secret') }}</label>
        <input
          :id="`${uid}-secret`"
          v-model="secret"
          class="sc-input"
          type="password"
          autocomplete="new-password"
          :placeholder="saved?.secretSet ? t('adminSignupCaptcha.secretKept') : ''"
          :aria-invalid="fieldError === 'secret' ? 'true' : undefined"
          :aria-describedby="`${uid}-secret-hint`"
          data-testid="signup-captcha-secret"
        />
        <span :id="`${uid}-secret-hint`" class="sc-hint">{{ t('adminSignupCaptcha.secretHint') }}</span>

        <div class="sc-test">
          <div>
            <button
              type="button"
              class="sc-btn sc-btn--secondary"
              :disabled="!canTest || testRunning"
              :aria-describedby="`${uid}-test-hint`"
              data-testid="signup-captcha-test"
              @click="startTest"
            >
              {{ t('adminSignupCaptcha.test') }}
            </button>
          </div>
          <span :id="`${uid}-test-hint`" class="sc-hint">{{ t('adminSignupCaptcha.testHint') }}</span>
          <SignupCaptcha
            v-if="testing"
            :key="testKey"
            :config="{ provider: form.provider, siteKey: form.siteKey.trim() }"
            :note="testRunning ? t('adminSignupCaptcha.testRunning') : t('adminSignupCaptcha.testNote')"
            @token="onTestToken"
            @error="onTestWidgetError"
          />
          <p
            v-if="shownResult"
            :class="shownResult.ok ? 'sc-ok' : 'sc-error'"
            role="status"
            data-testid="signup-captcha-test-result"
          >
            {{ resultText }}
          </p>
        </div>

        <fieldset class="sc-modes">
          <legend class="sc-label">{{ t('adminSignupCaptcha.mode') }}</legend>
          <label class="sc-check">
            <input v-model="form.mode" type="radio" value="suspect" data-testid="signup-captcha-mode-suspect" />
            <span>{{ t('adminSignupCaptcha.modeSuspect') }}</span>
          </label>
          <span class="sc-hint">{{ t('adminSignupCaptcha.modeSuspectHint') }}</span>
          <label class="sc-check">
            <input v-model="form.mode" type="radio" value="always" data-testid="signup-captcha-mode-always" />
            <span>{{ t('adminSignupCaptcha.modeAlways') }}</span>
          </label>
        </fieldset>
      </template>

      <p class="sc-error" role="alert" data-testid="signup-captcha-error">{{ formError }}</p>
      <div>
        <button type="submit" class="sc-btn" :disabled="saving || !changed" data-testid="signup-captcha-save">
          {{ t('adminSignupCaptcha.save') }}
        </button>
      </div>
    </form>

    <div v-if="counts" class="sc-counts" data-testid="signup-captcha-counts">
      <h4 class="sc-label">{{ t('adminSignupCaptcha.countsTitle') }}</h4>
      <dl>
        <div>
          <dt>{{ t('adminSignupCaptcha.asked') }}</dt>
          <dd data-testid="signup-captcha-asked">{{ counts.asked }}</dd>
        </div>
        <div>
          <dt>{{ t('adminSignupCaptcha.passed') }}</dt>
          <dd data-testid="signup-captcha-passed">{{ counts.passed }}</dd>
        </div>
        <div>
          <dt>{{ t('adminSignupCaptcha.failed') }}</dt>
          <dd data-testid="signup-captcha-failed">{{ counts.failed }}</dd>
        </div>
        <div>
          <dt>{{ t('adminSignupCaptcha.unverified') }}</dt>
          <dd data-testid="signup-captcha-unverified">{{ counts.unverified }}</dd>
        </div>
      </dl>
      <p v-if="counts.unverified > 0" class="sc-hint" data-testid="signup-captcha-unverified-note">
        {{ t('adminSignupCaptcha.unverifiedHint') }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useAuthStore } from '@/stores/auth'
import {
  checkProblem,
  isValidSecret,
  isValidSiteKey,
  loadSignupCaptchaCounts,
  loadSignupCaptchaSettings,
  saveSignupCaptchaSettings,
  testSignupCaptcha,
  widgetProblem,
  type SignupCaptchaCounts,
  type SignupCaptchaProblem,
  type SignupCaptchaSettings,
} from '@/services/SignupCaptchaService'
import { captchaPageOrigin } from '@/utils/signupCaptcha'
import SignupCaptcha from '@/components/auth/SignupCaptcha.vue'
import { debug } from '@/utils/debug'

interface TestResult {
  /** Provider, site key and entered secret the result belongs to. */
  signature: string
  ok: boolean
  problem?: SignupCaptchaProblem
  detail?: string
  status?: number
}

const { t } = useI18n()
const toast = useToast()
const authStore = useAuthStore()
const uid = useId()
const pageOrigin = captchaPageOrigin()

const saved = ref<SignupCaptchaSettings | null>(null)
const form = ref<SignupCaptchaSettings | null>(null)
const secret = ref('')
const counts = ref<SignupCaptchaCounts | null>(null)
const loadError = ref('')
const formError = ref('')
const fieldError = ref<'site' | 'secret' | null>(null)
const saving = ref(false)

const changed = computed(() => {
  if (!form.value || !saved.value) return false
  return secret.value.trim() !== '' || JSON.stringify(form.value) !== JSON.stringify(saved.value)
})

// A provider turned on, or new keys, need a passing test: a wrong site key or a hostname the widget
// does not list leaves email sign-ups unable to finish, and a wrong secret makes every check
// unverified.
const testing = ref(false)
const testKey = ref(0)
const testRunning = ref(false)
const testResult = ref<TestResult | null>(null)

const signature = computed(() =>
  form.value ? `${form.value.provider}|${form.value.siteKey.trim()}|${secret.value.trim()}` : '')

const needsTest = computed(() => {
  if (!form.value || !saved.value || form.value.provider === 'off') return false
  return form.value.provider !== saved.value.provider
    || form.value.siteKey.trim() !== saved.value.siteKey
    || secret.value.trim() !== ''
})

const canTest = computed(() => {
  if (!form.value || form.value.provider === 'off' || !isValidSiteKey(form.value.siteKey)) return false
  return secret.value.trim() !== '' ? isValidSecret(secret.value) : !!saved.value?.secretSet
})

const shownResult = computed(() => (testResult.value?.signature === signature.value ? testResult.value : null))

const resultText = computed(() => {
  const r = shownResult.value
  if (!r) return ''
  if (r.ok) return t('adminSignupCaptcha.testPassed')
  const text = t(`adminSignupCaptcha.problem.${r.problem ?? 'unknown'}`, {
    host: new URL(pageOrigin).hostname,
    status: r.status ?? '',
  })
  return r.detail ? `${text} (${r.detail})` : text
})

function startTest() {
  testResult.value = null
  testKey.value++
  testing.value = true
}

async function onTestToken(token: string) {
  if (!form.value || form.value.provider === 'off') return
  const sig = signature.value
  testRunning.value = true
  try {
    const check = await testSignupCaptcha(form.value.provider, token, secret.value)
    const problem = checkProblem(check)
    testResult.value = problem
      ? { signature: sig, ok: false, problem, detail: check.message || check.codes.join(', ') || undefined, status: check.http_status }
      : { signature: sig, ok: true }
  } catch (error) {
    debug.error('Testing the sign-up check failed:', error)
    testResult.value = { signature: sig, ok: false, problem: 'unknown' }
  } finally {
    testRunning.value = false
    testing.value = false
  }
}

function onTestWidgetError(code: string) {
  testResult.value = { signature: signature.value, ok: false, problem: widgetProblem(code), detail: code }
  testing.value = false
}

async function save() {
  if (!form.value || !saved.value || saving.value) return
  formError.value = ''
  fieldError.value = null
  const next: SignupCaptchaSettings = { ...form.value, siteKey: form.value.siteKey.trim() }
  if (next.provider !== 'off') {
    if (!isValidSiteKey(next.siteKey)) {
      fieldError.value = 'site'
      formError.value = t('adminSignupCaptcha.invalidSiteKey')
      return
    }
    if (secret.value.trim() !== '' ? !isValidSecret(secret.value) : !saved.value.secretSet) {
      fieldError.value = 'secret'
      formError.value = t('adminSignupCaptcha.invalidSecret')
      return
    }
    if (needsTest.value && !shownResult.value?.ok) {
      formError.value = t('adminSignupCaptcha.needsTest')
      return
    }
  }
  saving.value = true
  try {
    await saveSignupCaptchaSettings(next, saved.value, secret.value, authStore.session?.user?.id ?? '')
    const stored = { ...next, secretSet: saved.value.secretSet || secret.value.trim() !== '' }
    saved.value = stored
    form.value = { ...stored }
    secret.value = ''
    toast.success(t('adminSignupCaptcha.saved'))
  } catch (error) {
    debug.error('Saving the sign-up check failed:', error)
    formError.value = t('adminSignupCaptcha.saveFailed')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    const settings = await loadSignupCaptchaSettings()
    saved.value = settings
    form.value = { ...settings }
  } catch (error) {
    debug.error('Loading the sign-up check failed:', error)
    loadError.value = t('adminSignupCaptcha.loadFailed')
    return
  }
  try {
    counts.value = await loadSignupCaptchaCounts()
  } catch (error) {
    debug.warn('Loading sign-up check counts failed:', error)
  }
})
</script>

<style scoped>
.sc-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  min-width: 0;
}

.sc-title {
  margin: 0;
  font-size: var(--font-size-md, 1rem);
  font-weight: 600;
  color: var(--text-primary);
}

.sc-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.sc-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 480px;
}

.sc-label {
  margin: var(--space-2) 0 0;
  padding: 0;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.sc-input {
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

.sc-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.sc-input[aria-invalid='true'] {
  border-color: var(--danger);
}

.sc-modes {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  border: 0;
}

.sc-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.sc-error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--danger);
}

.sc-error:empty {
  display: none;
}

.sc-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
}

.sc-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sc-btn--secondary {
  background: var(--background-quinary);
  color: var(--text-primary);
}

.sc-test {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.sc-ok {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--success, var(--text-primary));
}

.sc-counts dl {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin: var(--space-2) 0 var(--space-3);
}

.sc-counts dt {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.sc-counts dd {
  margin: 0;
  font-size: var(--font-size-md, 1rem);
  font-weight: 600;
  color: var(--text-primary);
}
</style>
