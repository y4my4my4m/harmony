<template>
  <section class="sp-card" :aria-labelledby="`${uid}-title`" data-testid="signup-providers">
    <h3 :id="`${uid}-title`" class="sp-title">{{ t('adminSignupProviders.title') }}</h3>
    <p class="sp-hint">{{ t('adminSignupProviders.intro') }}</p>

    <p v-if="loadError" class="sp-error" role="alert">{{ loadError }}</p>
    <p v-else-if="loaded && !rows.length" class="sp-hint" data-testid="signup-providers-none">{{ t('adminSignupProviders.noneTab', { tab: t('admin.panel.tabs.config') }) }}</p>

    <form v-else-if="loaded" class="sp-form" novalidate @submit.prevent="save">
      <p v-if="switchOn" class="sp-note" role="status" data-testid="signup-providers-switch-on">
        {{ t('adminSignupProviders.switchOn') }}
      </p>

      <fieldset
        v-for="row in rows"
        :key="row.id"
        class="sp-provider"
        :data-testid="`signup-provider-${row.id}`"
      >
        <legend class="sp-name">{{ row.name }}</legend>
        <label class="sp-choice">
          <input v-model="row.mode" type="radio" :name="`${uid}-${row.id}`" value="follow" data-testid="signup-provider-follow" />
          <span>{{ t('adminSignupProviders.follow') }}</span>
        </label>
        <label class="sp-choice">
          <input v-model="row.mode" type="radio" :name="`${uid}-${row.id}`" value="open" data-testid="signup-provider-open" />
          <span>{{ t('adminSignupProviders.open') }}</span>
        </label>
        <label class="sp-choice">
          <input v-model="row.mode" type="radio" :name="`${uid}-${row.id}`" value="domains" data-testid="signup-provider-domains" />
          <span>{{ t('adminSignupProviders.domains') }}</span>
        </label>
        <p v-if="row.mode === 'open' && row.public" class="sp-hint sp-warn" data-testid="signup-provider-public">
          {{ t('adminSignupProviders.publicOpen', { provider: row.name }) }}
        </p>
        <template v-if="row.mode === 'domains'">
          <label class="sp-label" :for="`${uid}-${row.id}-domains`">
            {{ t('adminSignupProviders.domainsLabel', { provider: row.name }) }}
          </label>
          <textarea
            :id="`${uid}-${row.id}-domains`"
            v-model="row.domains"
            class="sp-input"
            rows="3"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :aria-invalid="invalidRow === row.id ? 'true' : undefined"
            :aria-describedby="`${uid}-${row.id}-domains-hint`"
            data-testid="signup-provider-domain-list"
          />
          <span :id="`${uid}-${row.id}-domains-hint`" class="sp-hint">{{ t('adminSignupProviders.domainsHint') }}</span>
        </template>
      </fieldset>

      <p class="sp-error" role="alert" data-testid="signup-providers-error">{{ formError }}</p>
      <div>
        <button type="submit" class="sp-btn" :disabled="saving || !changed" data-testid="signup-providers-save">
          {{ t('adminSignupProviders.save') }}
        </button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useAuthStore } from '@/stores/auth'
import {
  loadSignupProviders,
  saveSignupProviders,
  type SignupMode,
  type SignupProvider,
} from '@/services/SignupProvidersService'
import { parseBlockedDomains } from '@/utils/signupLimits'
import { debug } from '@/utils/debug'

interface Row {
  id: string
  name: string
  public: boolean
  mode: SignupMode
  /** One domain per line, as typed. */
  domains: string
}

const { t } = useI18n()
const toast = useToast()
const authStore = useAuthStore()
const uid = useId()

const saved = ref<SignupProvider[]>([])
const rows = ref<Row[]>([])
const switchOn = ref(false)
const loaded = ref(false)
const loadError = ref('')
const formError = ref('')
const invalidRow = ref<string | null>(null)
const saving = ref(false)

function toRows(providers: SignupProvider[]): Row[] {
  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    public: p.public,
    mode: p.signup.mode,
    domains: p.signup.domains.join('\n'),
  }))
}

const changed = computed(() => JSON.stringify(rows.value) !== JSON.stringify(toRows(saved.value)))

async function save() {
  if (saving.value) return
  formError.value = ''
  invalidRow.value = null

  const next: SignupProvider[] = []
  for (const row of rows.value) {
    let domains: string[] = []
    if (row.mode === 'domains') {
      const parsed = parseBlockedDomains(row.domains)
      if (parsed.invalid !== null) {
        invalidRow.value = row.id
        formError.value = t('adminSignupProviders.invalidDomain', { domain: parsed.invalid })
        return
      }
      if (!parsed.domains.length) {
        invalidRow.value = row.id
        formError.value = t('adminSignupProviders.noDomains', { provider: row.name })
        return
      }
      domains = parsed.domains
    }
    next.push({ id: row.id, name: row.name, public: row.public, signup: { mode: row.mode, domains } })
  }

  saving.value = true
  try {
    await saveSignupProviders(next, authStore.session?.user?.id ?? '')
    saved.value = next
    rows.value = toRows(next)
    toast.success(t('adminSignupProviders.saved'))
  } catch (error) {
    debug.error('Saving sign-up through providers failed:', error)
    formError.value = t('adminSignupProviders.saveFailed')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    const result = await loadSignupProviders()
    saved.value = result.providers
    rows.value = toRows(result.providers)
    switchOn.value = result.switchOn === true
    loaded.value = true
  } catch (error) {
    debug.error('Loading sign-in providers failed:', error)
    loadError.value = t('adminSignupProviders.loadFailed')
  }
})
</script>

<style scoped>
.sp-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  min-width: 0;
}

.sp-title {
  margin: 0;
  font-size: var(--font-size-md, 1rem);
  font-weight: 600;
  color: var(--text-primary);
}

.sp-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.sp-warn {
  color: var(--warning, var(--text-secondary));
}

.sp-note {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--warning, var(--harmony-primary));
  background: var(--background-tertiary);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.sp-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 480px;
}

.sp-provider {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm, 4px);
  min-width: 0;
}

.sp-name {
  padding: 0 var(--space-1);
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.sp-choice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.sp-label {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
}

.sp-input {
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

.sp-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.sp-input[aria-invalid='true'] {
  border-color: var(--danger);
}

.sp-error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--danger);
}

.sp-error:empty {
  display: none;
}

.sp-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
}

.sp-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
