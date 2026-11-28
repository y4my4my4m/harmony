<template>
  <div v-if="issuing && !code" class="db-muted" role="status">{{ t('discordBridge.self.issuing') }}</div>

  <div v-else-if="issueError" class="db-banner db-banner--error" role="alert">
    <p>{{ issueError }}</p>
    <div class="db-actions">
      <button type="button" class="btn btn-secondary btn-sm" @click="issueCode">{{ t('discordBridge.common.retry') }}</button>
    </div>
  </div>

  <template v-else-if="code">
    <div class="code-line" data-testid="setup-code">
      <span class="db-label">{{ t('discordBridge.self.codeLabel') }}</span>
      <code class="db-inline-code">{{ code }}</code>
      <span :class="['db-badge', expired ? 'db-badge--error' : '']" data-testid="code-expiry">
        {{ expired ? t('discordBridge.self.codeExpired') : t('discordBridge.self.codeExpires', { count: remaining }, remaining) }}
      </span>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="issuing"
        data-testid="new-code"
        @click="issueCode"
      >
        <Icon name="refresh-cw" :size="14" aria-hidden="true" />
        {{ t('discordBridge.self.newCode') }}
      </button>
    </div>
    <p class="db-muted">{{ t('discordBridge.self.codeOnce') }}</p>

    <div v-if="expired" class="db-banner db-banner--warn" role="alert" data-testid="code-expired">
      <p>{{ t('discordBridge.self.expiredHelp') }}</p>
    </div>

    <div class="variant-tabs" role="tablist" :aria-label="t('discordBridge.self.variantLabel')">
      <button
        v-for="v in variants"
        :id="`${uid}-tab-${v}`"
        :key="v"
        type="button"
        role="tab"
        :aria-selected="variant === v"
        :aria-controls="`${uid}-panel`"
        :tabindex="variant === v ? 0 : -1"
        :class="['variant-tab', { active: variant === v }]"
        :data-testid="`variant-${v}`"
        @click="variant = v"
        @keydown.right.prevent="cycle(1)"
        @keydown.left.prevent="cycle(-1)"
      >
        {{ variantName(v) }}
      </button>
    </div>

    <div :id="`${uid}-panel`" role="tabpanel" :aria-labelledby="`${uid}-tab-${variant}`">
      <slot :variant="variant" :code="code" />
    </div>

    <details class="db-details">
      <summary>{{ t('discordBridge.self.troubleTitle') }}</summary>
      <slot name="trouble" :variant="variant" />
    </details>
  </template>

  <div v-else class="db-actions">
    <button type="button" class="btn btn-primary" data-testid="issue-code" @click="issueCode">
      {{ t('discordBridge.self.getCode') }}
    </button>
  </div>
</template>

<script setup lang="ts" generic="Variant extends string">
import { computed, onMounted, onUnmounted, ref, useId, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import { SETUP_CODE_TTL_MS } from '@/utils/discordBridgeSetup'
import { lastIssuedSetupCode, type IssuedSetupCode } from './bridgeApi'
import { bridgeErrorKey } from './bridgeErrors'
import { minutesLeft } from './bridgeTime'

const props = withDefaults(
  defineProps<{
    bridgeId: string
    /** Issues a code for the bridge; it cancels older ones. */
    issue: (bridgeId: string) => Promise<IssuedSetupCode>
    /** The ways to start the bridge; the first is shown. */
    variants: readonly Variant[]
    variantName: (variant: Variant) => string
    /** Issue a code on mount; off where reinstalling is optional. */
    autoIssue?: boolean
  }>(),
  { autoIssue: true },
)

const { t } = useI18n()
const uid = `bridge-code-${useId()}`

const code = ref('')
const issuedAt = ref(0)
const issuing = ref(false)
const issueError = ref('')
const variant = ref(props.variants[0]) as Ref<Variant>
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null

const remaining = computed(() => minutesLeft(issuedAt.value + SETUP_CODE_TTL_MS, now.value))
const expired = computed(() => !!code.value && remaining.value === 0)

function cycle(delta: number) {
  const count = props.variants.length
  variant.value = props.variants[(props.variants.indexOf(variant.value) + delta + count) % count]
  document.getElementById(`${uid}-tab-${variant.value}`)?.focus()
}

async function issueCode() {
  issuing.value = true
  issueError.value = ''
  try {
    const issued = await props.issue(props.bridgeId)
    code.value = issued.code
    issuedAt.value = issued.issuedAt
    now.value = Date.now()
  } catch (error) {
    debug.error('Bridge setup code failed:', error)
    issueError.value = t(bridgeErrorKey(error, 'discordBridge.errors.setupCode'))
  } finally {
    issuing.value = false
  }
}

onMounted(() => {
  ticker = setInterval(() => (now.value = Date.now()), 15_000)
  const previous = lastIssuedSetupCode(props.bridgeId)
  if (previous && minutesLeft(previous.issuedAt + SETUP_CODE_TTL_MS, now.value) > 0) {
    code.value = previous.code
    issuedAt.value = previous.issuedAt
  } else if (props.autoIssue) {
    void issueCode()
  }
})

onUnmounted(() => {
  if (ticker) clearInterval(ticker)
})
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.code-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.code-line .db-inline-code {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.variant-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  margin: 4px 0 12px;
  border-radius: 8px;
  background: var(--background-tertiary);
  max-width: 100%;
  flex-wrap: wrap;
}

.variant-tab {
  border: none;
  background: none;
  color: var(--text-secondary);
  padding: 6px 12px;
  min-height: 32px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.variant-tab.active {
  background: var(--background-secondary);
  color: var(--text-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

.variant-tab:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}
</style>
