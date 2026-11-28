<template>
  <div data-testid="matrix-managed-status" :data-state="kind">
    <section class="db-card" :aria-labelledby="`${uid}-status`">
      <div class="status-head">
        <span :class="['status-dot', kind]" aria-hidden="true"></span>
        <div class="status-text">
          <h3 :id="`${uid}-status`" class="db-card-title" data-testid="status-title">
            {{ t(kind === 'starting' ? 'matrixBridge.managed.starting' : `discordBridge.status.${kind}`) }}
          </h3>
          <p class="db-muted" data-testid="status-seen">
            {{ bridge.last_seen_at ? t('discordBridge.status.lastSeen', { ago: lastSeenAgo }) : t('discordBridge.status.neverSeen') }}
          </p>
        </div>
      </div>
      <dl class="facts">
        <div>
          <dt>{{ t('discordBridge.status.runs') }}</dt>
          <dd data-testid="status-mode">
            {{ t(bridge.mode === 'instance' ? 'matrixBridge.managed.instanceMode' : `discordBridge.status.mode.${bridge.mode}`) }}
          </dd>
        </div>
        <div>
          <dt>{{ t('matrixBridge.managed.account') }}</dt>
          <dd data-testid="status-account">{{ bridge.status.userId ?? t('discordBridge.status.unknown') }}</dd>
        </div>
        <div>
          <dt>{{ t('matrixBridge.managed.homeserver') }}</dt>
          <dd data-testid="status-homeserver">{{ bridge.status.serverName ?? bridge.status.homeserver ?? t('discordBridge.status.unknown') }}</dd>
        </div>
        <div>
          <dt>{{ t('matrixBridge.managed.connection') }}</dt>
          <dd data-testid="status-connection">
            {{ bridge.connection ? t(`matrixBridge.managed.connectionKind.${bridge.connection}`) : t('discordBridge.status.unknown') }}
          </dd>
        </div>
        <div>
          <dt>{{ t('discordBridge.status.version') }}</dt>
          <dd data-testid="status-version">{{ bridge.bridge_version ?? t('discordBridge.status.unknown') }}</dd>
        </div>
        <div v-if="bridge.status.pending">
          <dt>{{ t('matrixBridge.managed.pending') }}</dt>
          <dd data-testid="status-pending">{{ bridge.status.pending }}</dd>
        </div>
        <div v-if="bridge.status.failed">
          <dt>{{ t('matrixBridge.managed.failed') }}</dt>
          <dd data-testid="status-failed">{{ bridge.status.failed }}</dd>
        </div>
      </dl>
      <div class="db-actions">
        <button type="button" class="btn btn-secondary btn-sm" data-testid="show-setup" @click="emit('show-setup')">
          {{ t('discordBridge.status.showSetup') }}
        </button>
      </div>
    </section>

    <section v-if="problems.length" class="db-card" :aria-labelledby="`${uid}-problems`">
      <h3 :id="`${uid}-problems`" class="db-card-title">{{ problemsTitle }}</h3>
      <MatrixProblemList :bridge="bridge" :problems="problems" :harmony-url="harmonyUrl" @go="onGo" />
    </section>

    <section ref="pairsSection" class="db-card" :aria-labelledby="`${uid}-pairs`">
      <h3 :id="`${uid}-pairs`" class="db-card-title">{{ t('discordBridge.status.pairsTitle') }}</h3>
      <MatrixManagedPairs
        :bridge="bridge"
        :harmony-channels="harmonyChannels"
        :encrypted-channel-ids="encryptedChannelIds"
        :now="now"
        @state="(state) => emit('state', state)"
      />
    </section>

    <section class="db-card" :aria-labelledby="`${uid}-privacy`">
      <h3 :id="`${uid}-privacy`" class="db-card-title">{{ t('discordBridge.privacy.title') }}</h3>
      <BridgePrivacyPanel :server-id="bridge.server_id" platform="matrix" />
    </section>

    <section v-if="bridge.mode !== 'instance'" class="db-card" :aria-labelledby="`${uid}-maintain`">
      <h3 :id="`${uid}-maintain`" class="db-card-title">{{ t('discordBridge.status.maintainTitle') }}</h3>
      <details ref="maintainDetails" class="db-details" :open="maintainOpen" data-testid="matrix-maintain" @toggle="onMaintainToggle">
        <summary>{{ t(bridge.mode === 'hosted' ? 'matrixBridge.hosted.replace' : 'discordBridge.status.maintain.self') }}</summary>
        <template v-if="maintainOpen">
          <MatrixConnectSelf
            v-if="bridge.mode === 'self'"
            :bridge-id="bridge.id"
            :harmony-url="harmonyUrl"
            :connection="bridge.connection"
            :auto-issue="false"
          />
          <MatrixConnectHosted v-else :bridge-id="bridge.id" :homeserver-url="bridge.homeserver_url" @saved="(state) => emit('state', state)" />
        </template>
      </details>
    </section>

    <section class="db-card danger" :aria-labelledby="`${uid}-danger`">
      <h3 :id="`${uid}-danger`" class="db-card-title">{{ t('discordBridge.status.disconnectTitle') }}</h3>
      <p class="db-muted" data-testid="disconnect-body">
        {{ t('matrixBridge.managed.disconnectBody') }}
        <template v-if="disconnectMore">{{ t(disconnectMore) }}</template>
      </p>
      <p class="db-muted" data-testid="disconnect-keeps">{{ t('discordBridge.status.disconnectKeeps') }}</p>
      <div class="db-actions">
        <button type="button" class="btn btn-danger" data-testid="disconnect" @click="emit('delete')">
          {{ t('discordBridge.status.disconnect') }}
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HarmonyChannelOption } from '@/utils/discordBridgeSetup'
import { collectMatrixProblems, isMatrixNotice, matrixStatusKind, type MatrixBridgeState } from '@/utils/matrixBridgeSetup'
import { formatAgo } from '@/components/settings/discord-bridge/bridgeTime'
import BridgePrivacyPanel from '@/components/settings/discord-bridge/BridgePrivacyPanel.vue'
import MatrixConnectHosted from './MatrixConnectHosted.vue'
import MatrixConnectSelf from './MatrixConnectSelf.vue'
import MatrixManagedPairs from './MatrixManagedPairs.vue'
import MatrixProblemList from './MatrixProblemList.vue'

const props = defineProps<{
  bridge: MatrixBridgeState
  harmonyChannels: HarmonyChannelOption[]
  encryptedChannelIds: string[]
  now: number
  harmonyUrl: string
}>()

const emit = defineEmits<{
  state: [state: MatrixBridgeState]
  'show-setup': []
  delete: []
}>()

const { t } = useI18n()
const uid = `matrix-managed-${useId()}`
const maintainOpen = ref(false)
const maintainDetails = ref<HTMLDetailsElement | null>(null)
const pairsSection = ref<HTMLElement | null>(null)

const kind = computed(() => matrixStatusKind(props.bridge, props.now))
const problems = computed(() => collectMatrixProblems(props.bridge, props.now))
const toFix = computed(() => problems.value.filter((problem) => !isMatrixNotice(problem)).length)
const problemsTitle = computed(() =>
  toFix.value
    ? t('discordBridge.status.problemsTitle', { count: toFix.value }, toFix.value)
    : t('discordBridge.status.noticesTitle', { count: problems.value.length }, problems.value.length),
)
const lastSeenAgo = computed(() => formatAgo(t, props.bridge.last_seen_at, props.now))

/** What else ends with the bridge, and what is left to do. */
const disconnectMore = computed(() => {
  if (props.bridge.mode === 'hosted') return 'matrixBridge.managed.disconnectHosted'
  if (props.bridge.mode === 'instance') return 'matrixBridge.managed.disconnectInstance'
  if (props.bridge.connection === 'account') return 'matrixBridge.managed.disconnectAccount'
  return props.bridge.connection === 'application_service' ? 'matrixBridge.managed.disconnectRegistration' : ''
})

function onMaintainToggle(event: Event) {
  maintainOpen.value = (event.target as HTMLDetailsElement).open
}

async function onGo(step: 'connect' | 'channels') {
  if (step === 'channels') {
    pairsSection.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return
  }
  maintainOpen.value = true
  await nextTick()
  maintainDetails.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  maintainDetails.value?.querySelector('summary')?.focus()
}
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.status-dot.starting {
  background: var(--harmony-primary);
}
</style>
