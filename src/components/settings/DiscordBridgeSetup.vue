<template>
  <section class="discord-bridge" aria-labelledby="discord-bridge-title" data-testid="discord-bridge">
    <div class="settings-section">
      <h2 id="discord-bridge-title" class="section-title">{{ t('discordBridge.title') }}</h2>
      <p class="section-description">{{ t('discordBridge.intro') }}</p>
    </div>

    <div v-if="loading" class="loading-state" role="status">
      <LoadingSpinner :size="32" />
      <span>{{ t('discordBridge.loading') }}</span>
    </div>

    <template v-else>
      <div v-if="unavailable" class="db-banner db-banner--warn" role="status" data-testid="bridge-unavailable">
        <p>{{ t('discordBridge.errors.unavailable') }}</p>
      </div>

      <div v-else-if="loadError" class="db-banner db-banner--error" role="alert" data-testid="bridge-load-error">
        <p>{{ t('discordBridge.errors.load') }}</p>
        <p v-if="loadError !== '-'" class="db-muted">{{ loadError }}</p>
        <div class="db-actions">
          <button type="button" class="btn btn-secondary btn-sm" @click="load">{{ t('discordBridge.common.retry') }}</button>
        </div>
      </div>

      <template v-else>
        <div v-if="actionError" class="db-banner db-banner--error" role="alert" data-testid="bridge-action-error">
          <p>{{ actionError }}</p>
          <p v-if="actionDetail" class="db-muted">{{ actionDetail }}</p>
        </div>

        <div v-if="linkError" class="db-banner db-banner--error" role="alert" data-testid="bridge-link-error">
          <p>{{ t(`discordBridge.instance.linkError.${linkError}`) }}</p>
          <div class="db-actions">
            <button
              v-if="linkError !== 'limit_reached'"
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="busy"
              data-testid="link-retry"
              @click="retryLink"
            >
              {{ t('discordBridge.instance.retry') }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" data-testid="link-error-dismiss" @click="linkError = null">
              {{ t('discordBridge.common.dismiss') }}
            </button>
          </div>
        </div>

        <section v-if="!bridge && legacy" class="db-card upgrade" aria-labelledby="bridge-upgrade-title" data-testid="upgrade-card">
          <h3 id="bridge-upgrade-title" class="db-card-title">{{ t('discordBridge.upgrade.title') }}</h3>
          <p class="db-text">{{ t('discordBridge.upgrade.body') }}</p>
          <p class="db-muted">{{ t('discordBridge.upgrade.doubleRelay') }}</p>
        </section>

        <BridgeModeChooser
          v-if="!bridge"
          :hosting-enabled="hostingEnabled"
          :instance-bot-enabled="instanceBotEnabled"
          :instance-name="instanceName"
          :busy="busy"
          @choose="create"
        />

        <BridgeStatusView
          v-else-if="view === 'status'"
          :bridge="bridge"
          :pairs="pairs"
          :harmony-channels="channels"
          :now="now"
          :harmony-url="harmonyUrl"
          @changed="refresh"
          @show-setup="showSetup"
          @delete="askDelete('disconnect')"
        />

        <BridgeSetupStepper
          v-else
          :key="`${bridge.id}:${stepperKey}`"
          :bridge="bridge"
          :pairs="pairs"
          :harmony-channels="channels"
          :now="now"
          :harmony-url="harmonyUrl"
          :server-name="serverName"
          :initial-step="initialStep"
          @changed="refresh"
          @finish="finish"
          @start-over="askDelete('startOver')"
        />

        <div v-if="bridge && legacy" class="db-banner db-banner--warn" data-testid="legacy-still-there">
          <p>{{ t('discordBridge.upgrade.doubleRelay') }}</p>
        </div>
      </template>

      <BridgeLegacyInfo v-if="legacy" :server-id="serverId" :pairing-code="legacy.pairing_code" :harmony-url="harmonyUrl" />
    </template>

    <ConfirmationModal
      :show="confirm !== null"
      :title="confirm ? t(`discordBridge.confirm.${confirm}.title`) : ''"
      :message="confirm ? t(`discordBridge.confirm.${confirm}.message`) : ''"
      :secondary-message="confirmNote"
      :confirm-button-text="confirm ? t(`discordBridge.confirm.${confirm}.button`) : ''"
      @confirm="runDelete"
      @close="confirm = null"
      @update:model-value="(open: boolean) => { if (!open) confirm = null }"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ConfirmationModal from '@/components/ConfirmationModal.vue'
import { debug } from '@/utils/debug'
import {
  BRIDGE_REMOVE_COMMAND,
  resolveHarmonyBaseUrl,
  resolveInstanceName,
  type BridgeLinkReturn,
  type BridgeMode,
  type LinkErrorCode,
  type BridgePairRow,
  type DiscordBridgeRow,
  type HarmonyChannelOption,
  type SetupStep,
} from '@/utils/discordBridgeSetup'
import {
  BridgeUnavailableError,
  createBridge,
  createInstanceLink,
  deleteBridge,
  fetchBridge,
  fetchBridgePairs,
  fetchHostingEnabled,
  fetchInstanceBotEnabled,
  fetchLegacyPairing,
  fetchServerTextChannels,
  type LegacyPairing,
} from './discord-bridge/bridgeApi'
import { bridgeErrorKey, errorDetail } from './discord-bridge/bridgeErrors'
import { startInstanceLink } from './discord-bridge/instanceLink'
import BridgeModeChooser from './discord-bridge/BridgeModeChooser.vue'
import BridgeSetupStepper from './discord-bridge/BridgeSetupStepper.vue'
import BridgeStatusView from './discord-bridge/BridgeStatusView.vue'
import BridgeLegacyInfo from './discord-bridge/BridgeLegacyInfo.vue'

const props = withDefaults(
  defineProps<{
    serverId: string
    serverName?: string
    /** The instance bot's OAuth2 callback outcome, read from ?linked / ?link_error. */
    linkReturn?: BridgeLinkReturn | null
  }>(),
  { serverName: '', linkReturn: null },
)

/** Status and snapshot refresh; the bridge heartbeats every 30 s and on change. */
const POLL_MS = 5000

const { t } = useI18n()
const toast = useToast()
const harmonyUrl = resolveHarmonyBaseUrl()
const instanceName = resolveInstanceName()

const loading = ref(true)
const loadError = ref('')
const unavailable = ref(false)
const busy = ref(false)
const actionError = ref('')
const actionDetail = ref('')

const bridge = ref<DiscordBridgeRow | null>(null)
const pairs = ref<BridgePairRow[]>([])
const channels = ref<HarmonyChannelOption[]>([])
const legacy = ref<LegacyPairing | null>(null)
const hostingEnabled = ref(false)
const instanceBotEnabled = ref(false)
const linkError = ref<LinkErrorCode | null>(props.linkReturn?.error ?? null)
const now = ref(Date.now())

const view = ref<'setup' | 'status'>('setup')
const initialStep = ref<SetupStep | null>(null)
const stepperKey = ref(0)
const confirm = ref<'disconnect' | 'startOver' | null>(null)

const confirmNote = computed(() => {
  if (!confirm.value) return ''
  if (bridge.value?.mode === 'self') return t('discordBridge.confirm.selfNote', { command: BRIDGE_REMOVE_COMMAND })
  if (bridge.value?.mode === 'instance' && bridge.value.discord_guild_id) return t('discordBridge.confirm.instanceNote')
  return ''
})

let timer: ReturnType<typeof setInterval> | null = null
let refreshSeq = 0

async function readBridge(): Promise<void> {
  const seq = ++refreshSeq
  const row = await fetchBridge(props.serverId)
  const rows = row ? await fetchBridgePairs(row.id) : []
  if (seq !== refreshSeq) return
  bridge.value = row
  pairs.value = rows
}

async function load() {
  loading.value = true
  loadError.value = ''
  unavailable.value = false
  const [bridgeResult, channelResult, hostingResult, legacyResult, instanceResult] = await Promise.allSettled([
    readBridge(),
    fetchServerTextChannels(props.serverId),
    fetchHostingEnabled(),
    fetchLegacyPairing(props.serverId),
    fetchInstanceBotEnabled(),
  ])
  if (channelResult.status === 'fulfilled') channels.value = channelResult.value
  hostingEnabled.value = hostingResult.status === 'fulfilled' && hostingResult.value
  instanceBotEnabled.value = instanceResult.status === 'fulfilled' && instanceResult.value
  legacy.value = legacyResult.status === 'fulfilled' ? legacyResult.value : null
  if (bridgeResult.status === 'rejected') {
    if (bridgeResult.reason instanceof BridgeUnavailableError) {
      unavailable.value = true
    } else {
      debug.error('Discord bridge load failed:', bridgeResult.reason)
      loadError.value = errorDetail(bridgeResult.reason) || '-'
    }
  } else if (channelResult.status === 'rejected') {
    debug.error('Server channels load failed:', channelResult.reason)
    loadError.value = errorDetail(channelResult.reason) || '-'
  }
  view.value = pairs.value.length > 0 ? 'status' : 'setup'
  now.value = Date.now()
  loading.value = false
  if (props.linkReturn?.linked && bridge.value?.discord_guild_id) {
    toast.success(t('discordBridge.instance.linked', { guild: bridge.value.discord_guild_name || bridge.value.discord_guild_id }))
  }
}

async function refresh() {
  try {
    await readBridge()
    now.value = Date.now()
  } catch (error) {
    debug.warn('Discord bridge refresh failed:', error)
  }
}

function poll() {
  now.value = Date.now()
  if (!bridge.value || loading.value) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  void refresh()
}

function onVisibility() {
  if (document.visibilityState === 'visible') poll()
}

function clearAction() {
  actionError.value = ''
  actionDetail.value = ''
}

/** The instance bridge is created by its first link request; that state is not used. */
async function create(mode: BridgeMode) {
  busy.value = true
  clearAction()
  try {
    if (mode === 'instance') await createInstanceLink(props.serverId)
    else await createBridge(props.serverId, mode)
    await refresh()
    view.value = 'setup'
    initialStep.value = null
    stepperKey.value++
  } catch (error) {
    debug.error('discord_bridge_create failed:', error)
    actionError.value = t(bridgeErrorKey(error, 'discordBridge.errors.create'))
    actionDetail.value = errorDetail(error)
  } finally {
    busy.value = false
  }
}

async function retryLink() {
  busy.value = true
  clearAction()
  try {
    await startInstanceLink(props.serverId)
    linkError.value = null
  } catch (error) {
    debug.error('discord_bridge_instance_link failed:', error)
    actionError.value = t(bridgeErrorKey(error, 'discordBridge.errors.link'))
    actionDetail.value = errorDetail(error)
  } finally {
    busy.value = false
  }
}

function showSetup(step: SetupStep | null) {
  initialStep.value = step
  stepperKey.value++
  view.value = 'setup'
}

function finish() {
  view.value = 'status'
  toast.success(t('discordBridge.status.finished'))
}

function askDelete(kind: 'disconnect' | 'startOver') {
  clearAction()
  confirm.value = kind
}

async function runDelete() {
  const row = bridge.value
  const kind = confirm.value
  confirm.value = null
  if (!row) return
  busy.value = true
  try {
    await deleteBridge(row.id)
    try {
      localStorage.removeItem(`harmony.discordBridge.reached.${row.id}`)
    } catch {
      /* storage unavailable */
    }
    bridge.value = null
    pairs.value = []
    view.value = 'setup'
    initialStep.value = null
    if (kind === 'disconnect') toast.success(t('discordBridge.status.disconnected'))
  } catch (error) {
    debug.error('discord_bridge_delete failed:', error)
    actionError.value = t(bridgeErrorKey(error, 'discordBridge.errors.delete'))
    actionDetail.value = errorDetail(error)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void load()
  timer = setInterval(poll, POLL_MS)
  document.addEventListener('visibilitychange', onVisibility)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<style scoped src="./discord-bridge/bridge.css"></style>
<style scoped>
.discord-bridge {
  margin-bottom: 32px;
  max-width: 860px;
}

.settings-section {
  margin-bottom: 20px;
}

.section-title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-description {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 0;
  color: var(--text-secondary);
}

.upgrade {
  border-color: color-mix(in srgb, var(--harmony-primary) 45%, var(--background-quaternary));
}
</style>
