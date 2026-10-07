<template>
  <div data-testid="bridge-status">
    <section class="db-card" aria-labelledby="bridge-status-title">
      <div class="status-head">
        <span :class="['status-dot', statusKind]" aria-hidden="true"></span>
        <div class="status-text">
          <h3 id="bridge-status-title" class="db-card-title" data-testid="status-title">
            {{ t(`discordBridge.status.${statusKind}`) }}
          </h3>
          <p class="db-muted" data-testid="status-seen">
            {{ bridge.last_seen_at ? t('discordBridge.status.lastSeen', { ago: lastSeenAgo }) : t('discordBridge.status.neverSeen') }}
          </p>
        </div>
      </div>
      <dl class="facts">
        <div>
          <dt>{{ t('discordBridge.status.runs') }}</dt>
          <dd>{{ t(`discordBridge.status.mode.${bridge.mode}`) }}</dd>
        </div>
        <div>
          <dt>{{ t('discordBridge.status.discordServer') }}</dt>
          <dd>{{ guildName || t('discordBridge.status.none') }}</dd>
        </div>
        <div>
          <dt>{{ t('discordBridge.status.discordBot') }}</dt>
          <dd>{{ botName || t('discordBridge.status.unknown') }}</dd>
        </div>
        <div>
          <dt>{{ t('discordBridge.status.version') }}</dt>
          <dd data-testid="status-version">{{ bridge.bridge_version || t('discordBridge.status.unknown') }}</dd>
        </div>
      </dl>
      <div class="db-actions">
        <a v-if="inviteUrl" :href="inviteUrl" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">
          <Icon name="external-link" :size="14" aria-hidden="true" />
          {{ t('discordBridge.actions.invite') }}
        </a>
        <button type="button" class="btn btn-secondary btn-sm" data-testid="show-setup" @click="emit('show-setup', null)">
          {{ t('discordBridge.status.showSetup') }}
        </button>
      </div>
    </section>

    <section v-if="problems.length" class="db-card" aria-labelledby="bridge-problems-title">
      <h3 id="bridge-problems-title" class="db-card-title">{{ t('discordBridge.status.problemsTitle', { count: problems.length }, problems.length) }}</h3>
      <BridgeProblemList
        :bridge="bridge"
        :problems="problems"
        :harmony-channels="harmonyChannels"
        :harmony-url="harmonyUrl"
        @go="onGo"
        @changed="emit('changed')"
      />
    </section>

    <section ref="pairsSection" class="db-card" aria-labelledby="bridge-pairs-title">
      <h3 id="bridge-pairs-title" class="db-card-title">{{ t('discordBridge.status.pairsTitle') }}</h3>
      <BridgeChannelPairs :bridge="bridge" :pairs="pairs" :harmony-channels="harmonyChannels" @changed="emit('changed')" />
    </section>

    <section class="db-card" aria-labelledby="bridge-settings-title">
      <h3 id="bridge-settings-title" class="db-card-title">{{ t('discordBridge.status.settingsTitle') }}</h3>
      <BridgeSettingsPanel :bridge-id="bridge.id" :settings="settings" @changed="emit('changed')" />
    </section>

    <section class="db-card" aria-labelledby="bridge-maintain-title">
      <h3 id="bridge-maintain-title" class="db-card-title">{{ t('discordBridge.status.maintainTitle') }}</h3>
      <details ref="maintainDetails" class="db-details" :open="maintainOpen" @toggle="onMaintainToggle">
        <summary>{{ t(`discordBridge.status.maintain.${bridge.mode}`) }}</summary>
        <BridgeConnectSelf v-if="bridge.mode === 'self' && maintainOpen" :bridge-id="bridge.id" :harmony-url="harmonyUrl" :auto-issue="false" />
        <BridgeConnectHosted v-else-if="bridge.mode === 'hosted' && maintainOpen" :bridge-id="bridge.id" @saved="emit('changed')" />
      </details>
    </section>

    <section class="db-card danger" aria-labelledby="bridge-danger-title">
      <h3 id="bridge-danger-title" class="db-card-title">{{ t('discordBridge.status.disconnectTitle') }}</h3>
      <p class="db-muted">{{ t(`discordBridge.status.disconnectBody.${bridge.mode}`) }}</p>
      <div class="db-actions">
        <button type="button" class="btn btn-danger" data-testid="disconnect" @click="emit('delete')">
          {{ t('discordBridge.status.disconnect') }}
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import {
  buildDiscordInviteUrl,
  collectProblems,
  isBridgeOnline,
  normalizeBridgeSettings,
  parseBridgeStatus,
  parseSnapshotGuilds,
  type BridgePairRow,
  type DiscordBridgeRow,
  type HarmonyChannelOption,
  type SetupStep,
} from '@/utils/discordBridgeSetup'
import { formatAgo } from './bridgeTime'
import BridgeProblemList from './BridgeProblemList.vue'
import BridgeChannelPairs from './BridgeChannelPairs.vue'
import BridgeSettingsPanel from './BridgeSettingsPanel.vue'
import BridgeConnectSelf from './BridgeConnectSelf.vue'
import BridgeConnectHosted from './BridgeConnectHosted.vue'

const props = defineProps<{
  bridge: DiscordBridgeRow
  pairs: BridgePairRow[]
  harmonyChannels: HarmonyChannelOption[]
  now: number
  harmonyUrl: string
}>()

const emit = defineEmits<{
  changed: []
  'show-setup': [step: SetupStep | null]
  delete: []
}>()

const { t } = useI18n()
const maintainOpen = ref(false)
const maintainDetails = ref<HTMLDetailsElement | null>(null)
const pairsSection = ref<HTMLElement | null>(null)

const online = computed(() => isBridgeOnline(props.bridge.last_seen_at, props.now))
const problems = computed(() => collectProblems(props.bridge, props.now))
const statusKind = computed(() => {
  if (!props.bridge.last_seen_at) return 'never'
  if (!online.value) return 'offline'
  return problems.value.length ? 'degraded' : 'online'
})
const lastSeenAgo = computed(() => formatAgo(t, props.bridge.last_seen_at, props.now))
const settings = computed(() => normalizeBridgeSettings(props.bridge.settings))
const inviteUrl = computed(() => buildDiscordInviteUrl(props.bridge.discord_application_id))
const guildName = computed(
  () =>
    parseSnapshotGuilds(props.bridge.snapshot).find((g) => g.id === props.bridge.discord_guild_id)?.name ??
    props.bridge.discord_guild_name ??
    '',
)
const botName = computed(() => props.bridge.discord_bot_name || parseBridgeStatus(props.bridge.status).botName || '')

function onMaintainToggle(event: Event) {
  maintainOpen.value = (event.target as HTMLDetailsElement).open
}

async function onGo(step: 'connect' | 'guild' | 'channels') {
  if (step === 'connect') {
    maintainOpen.value = true
    await nextTick()
    maintainDetails.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    maintainDetails.value?.querySelector('summary')?.focus()
    return
  }
  if (step === 'channels') {
    pairsSection.value?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    return
  }
  emit('show-setup', step)
}
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.status-head {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.status-dot {
  width: 12px;
  height: 12px;
  margin-top: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-secondary);
}

.status-dot.online {
  background: var(--success);
}

.status-dot.degraded {
  background: var(--warning);
}

.status-dot.offline {
  background: var(--error);
}

.status-text {
  min-width: 0;
}

.status-text .db-card-title {
  margin-bottom: 2px;
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
  margin: 8px 0 16px;
}

.facts div {
  min-width: 0;
}

.facts dt {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.facts dd {
  margin: 2px 0 0;
  font-size: 14px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.danger {
  border-color: color-mix(in srgb, var(--error) 40%, var(--background-quaternary));
}

@media (max-width: 520px) {
  .facts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
