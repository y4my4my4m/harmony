<template>
  <div v-if="hosts" class="admin-card" data-testid="bridge-service" :data-platform="platform" :data-state="state">
    <h4>{{ t('matrixBridge.service.title') }}</h4>
    <p class="service-line">
      <span :class="['service-dot', state]" aria-hidden="true"></span>
      <span data-testid="service-seen">{{ seen }}</span>
      <span v-if="host?.version" class="hint" data-testid="service-version">{{ t('matrixBridge.service.version', { version: host.version }) }}</span>
    </p>

    <template v-if="state !== 'running'">
      <p class="hint">{{ t(`matrixBridge.service.absent.${platform}`) }}</p>
      <BridgeCopyBlock :text="`harmony bridges add ${platform}`" :label="t('discordBridge.common.commandLabel')" data-testid="service-command" />
      <p class="hint">
        <a :href="DOCS[platform]" target="_blank" rel="noopener noreferrer">{{ t('discordBridge.admin.docs') }}</a>
      </p>
    </template>

    <ul v-else-if="problems.length" class="service-problems" :aria-label="t('discordBridge.problems.listLabel')" data-testid="service-problems">
      <li v-for="problem in problems" :key="`${problem.code}:${problem.detail}`" :data-code="problem.code">
        <Icon name="alert-circle" :size="14" aria-hidden="true" />
        <span>
          {{ KNOWN.has(problem.code) ? t(`matrixBridge.service.problem.${problem.code}`) : t('discordBridge.problems.unknown.title', { code: problem.code }) }}
          <span v-if="problem.detail" class="hint detail">{{ problem.detail }}</span>
        </span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import { parseMatrixBridgeStatus } from '@/utils/matrixBridgeSetup'
import { fetchBridgeHosts, type BridgeHost, type BridgeRemotePlatform } from './bridgeApi'
import { formatAgo } from './bridgeTime'
import BridgeCopyBlock from './BridgeCopyBlock.vue'
import { useBridgePolling } from './useBridgePolling'

const props = defineProps<{ platform: BridgeRemotePlatform }>()

/** The gateway hears from a running service at least once a minute. */
const ABSENT_MS = 5 * 60_000
const DOCS: Record<BridgeRemotePlatform, string> = {
  discord: 'https://docs.mony.lol/self-host/discord-bridges',
  matrix: 'https://docs.mony.lol/self-host/matrix-bridges',
}
const KNOWN = new Set(['matrix_registration_missing', 'matrix_token_invalid', 'matrix_unreachable', 'harmony_unreachable', 'worker_stopped'])

const { t } = useI18n()
/** Null until read, and on an instance that does not report its services. */
const hosts = ref<BridgeHost[] | null>(null)

const { now } = useBridgePolling(() => hosts.value !== null, () => void load(), 30_000)

const host = computed(() => hosts.value?.find((h) => h.platform === props.platform) ?? null)
const state = computed<'never' | 'absent' | 'running'>(() => {
  const at = host.value?.lastSeenAt ? Date.parse(host.value.lastSeenAt) : NaN
  if (!Number.isFinite(at)) return 'never'
  return now.value - at > ABSENT_MS ? 'absent' : 'running'
})
const seen = computed(() =>
  state.value === 'never'
    ? t('matrixBridge.service.never')
    : t('discordBridge.status.lastSeen', { ago: formatAgo(t, host.value?.lastSeenAt, now.value) }),
)
/** status.instance.problems of the Matrix service's last report; Discord's reports none. */
const problems = computed(() => {
  const status = host.value?.status as { instance?: unknown } | null | undefined
  return parseMatrixBridgeStatus(status?.instance).problems
})

async function load() {
  try {
    hosts.value = await fetchBridgeHosts()
    now.value = Date.now()
  } catch (error) {
    debug.warn('bridge_hosts_status failed:', error)
  }
}

onMounted(() => void load())
</script>

<style scoped src="./bridgeAdmin.css"></style>
<style scoped>
.admin-card {
  margin-top: 16px;
}

.hint {
  margin: 0 0 8px;
}

.service-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--text-primary);
}

.service-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-secondary);
}

.service-dot.running {
  background: var(--success);
}

.service-dot.absent {
  background: var(--error);
}

.service-problems {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary);
}

.service-problems li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.service-problems :deep(.icon-wrap) {
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--text-danger);
}

.detail {
  display: block;
  overflow-wrap: anywhere;
}
</style>
