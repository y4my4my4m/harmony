<template>
  <div data-testid="connect-self">
    <p class="db-text">{{ t('discordBridge.self.lead') }}</p>
    <p class="db-muted">
      <i18n-t keypath="discordBridge.self.docker" tag="span" scope="global">
        <template #desktop>
          <a :href="DOCKER_DESKTOP_URL" target="_blank" rel="noopener noreferrer">Docker Desktop</a>
        </template>
        <template #engine>
          <a :href="DOCKER_ENGINE_URL" target="_blank" rel="noopener noreferrer">Docker Engine</a>
        </template>
      </i18n-t>
    </p>

    <div v-if="issuing && !code" class="db-muted" role="status">{{ t('discordBridge.self.issuing') }}</div>

    <div v-else-if="issueError" class="db-banner db-banner--error" role="alert">
      <p>{{ issueError }}</p>
      <div class="db-actions">
        <button type="button" class="btn btn-secondary btn-sm" @click="issue">{{ t('discordBridge.common.retry') }}</button>
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
          @click="issue"
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
          v-for="v in VARIANTS"
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
          {{ t(`discordBridge.self.variant.${v}`) }}
        </button>
      </div>

      <div :id="`${uid}-panel`" role="tabpanel" :aria-labelledby="`${uid}-tab-${variant}`">
        <ol class="db-steps">
          <li>
            {{ variant === 'run' ? t('discordBridge.self.run.copy') : t('discordBridge.self.compose.copy') }}
            <BridgeCopyBlock
              :text="variant === 'run' ? runCommand : composeFile"
              :label="variant === 'run' ? t('discordBridge.self.run.label') : t('discordBridge.self.compose.label')"
              :data-testid="variant === 'run' ? 'docker-run' : 'docker-compose'"
            />
          </li>
          <li>
            <i18n-t keypath="discordBridge.self.replaceToken" tag="span" scope="global">
              <template #placeholder><code class="db-inline-code">{{ DISCORD_TOKEN_PLACEHOLDER }}</code></template>
            </i18n-t>
          </li>
          <li v-if="variant === 'run'">{{ t('discordBridge.self.run.paste') }}</li>
          <li v-else>
            <i18n-t keypath="discordBridge.self.compose.run" tag="span" scope="global">
              <template #command><code class="db-inline-code">docker compose up -d</code></template>
            </i18n-t>
          </li>
        </ol>
      </div>

      <details class="db-details">
        <summary>{{ t('discordBridge.self.troubleTitle') }}</summary>
        <p class="db-muted">{{ t('discordBridge.self.troubleLogs') }}</p>
        <BridgeCopyBlock :text="BRIDGE_LOGS_COMMAND" :label="t('discordBridge.common.commandLabel')" />
        <p class="db-muted">{{ t('discordBridge.self.troubleNameInUse') }}</p>
        <BridgeCopyBlock :text="BRIDGE_REMOVE_COMMAND" :label="t('discordBridge.common.commandLabel')" />
        <p class="db-muted">{{ t('discordBridge.self.troubleReset') }}</p>
        <BridgeCopyBlock :text="BRIDGE_RESET_COMMAND" :label="t('discordBridge.common.commandLabel')" />
      </details>
    </template>

    <div v-else class="db-actions">
      <button type="button" class="btn btn-primary" data-testid="issue-code" @click="issue">
        {{ t('discordBridge.self.getCode') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import {
  BRIDGE_LOGS_COMMAND,
  BRIDGE_REMOVE_COMMAND,
  BRIDGE_RESET_COMMAND,
  DISCORD_TOKEN_PLACEHOLDER,
  SETUP_CODE_TTL_MS,
  buildDockerCompose,
  buildDockerRunCommand,
} from '@/utils/discordBridgeSetup'
import { createSetupCode, lastIssuedSetupCode } from './bridgeApi'
import { bridgeErrorKey } from './bridgeErrors'
import { minutesLeft } from './bridgeTime'
import BridgeCopyBlock from './BridgeCopyBlock.vue'

const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/'
const DOCKER_ENGINE_URL = 'https://docs.docker.com/engine/install/'
const VARIANTS = ['run', 'compose'] as const

const props = withDefaults(
  defineProps<{
    bridgeId: string
    harmonyUrl: string
    /** Issue a code on mount; off where reinstalling is optional. */
    autoIssue?: boolean
  }>(),
  { autoIssue: true },
)

const { t } = useI18n()
const uid = `bridge-self-${useId()}`

const code = ref('')
const issuedAt = ref(0)
const issuing = ref(false)
const issueError = ref('')
const variant = ref<(typeof VARIANTS)[number]>('run')
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null

const remaining = computed(() => minutesLeft(issuedAt.value + SETUP_CODE_TTL_MS, now.value))
const expired = computed(() => !!code.value && remaining.value === 0)
const runCommand = computed(() => buildDockerRunCommand({ harmonyUrl: props.harmonyUrl, setupCode: code.value }))
const composeFile = computed(() => buildDockerCompose({ harmonyUrl: props.harmonyUrl, setupCode: code.value }))

function cycle(delta: number) {
  const index = (VARIANTS.indexOf(variant.value) + delta + VARIANTS.length) % VARIANTS.length
  variant.value = VARIANTS[index]
  document.getElementById(`${uid}-tab-${variant.value}`)?.focus()
}

async function issue() {
  issuing.value = true
  issueError.value = ''
  try {
    const issued = await createSetupCode(props.bridgeId)
    code.value = issued.code
    issuedAt.value = issued.issuedAt
    now.value = Date.now()
  } catch (error) {
    debug.error('discord_bridge_setup_code failed:', error)
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
    void issue()
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

.db-steps .db-code-block {
  margin-top: 8px;
}
</style>
