<template>
  <section class="matrix-bridge" :aria-labelledby="`${uid}-title`" data-testid="matrix-bridge">
    <div class="settings-section">
      <h3 :id="`${uid}-title`" ref="heading" class="section-title" tabindex="-1">{{ t('matrixBridge.title') }}</h3>
      <p class="section-description">{{ t('matrixBridge.description') }}</p>
    </div>

    <div v-if="loading" class="loading-state" role="status">
      <LoadingSpinner :size="32" />
      <span>{{ t('matrixBridge.loading') }}</span>
    </div>

    <div v-else-if="loadError" class="db-banner db-banner--error" role="alert" data-testid="matrix-bridge-load-error">
      <p>{{ t('matrixBridge.loadError') }}</p>
      <div class="db-actions">
        <button type="button" class="btn btn-secondary btn-sm" @click="load">{{ t('discordBridge.common.retry') }}</button>
      </div>
    </div>

    <template v-else>
      <div v-if="actionError" class="db-banner db-banner--error" role="alert" data-testid="bridge-action-error">
        <p>{{ actionError }}</p>
      </div>

      <template v-if="!bridge && view === 'custom'">
        <MatrixCustomBridge :server-id="serverId" />
        <p v-if="managedOffered" class="db-muted other-ways">
          {{ t('matrixBridge.custom.otherPrompt') }}
          <button type="button" class="link-button" data-testid="matrix-other-ways" @click="show('chooser')">
            {{ t('matrixBridge.custom.other') }}
          </button>
        </p>
      </template>

      <BridgeModeChooser
        v-else-if="!bridge"
        platform="matrix"
        own-program
        :hosting-enabled="offers.hosted"
        :instance-bot-enabled="offers.instance"
        :instance-name="instanceName"
        :busy="busy"
        @choose="create"
        @choose-custom="show('custom')"
      />

      <template v-else>
        <MatrixStatusView
          v-if="view === 'status'"
          :bridge="bridge"
          :harmony-channels="channels"
          :encrypted-channel-ids="encryptedChannelIds"
          :now="now"
          :harmony-url="harmonyUrl"
          @state="apply"
          @show-setup="view = 'setup'"
          @delete="confirm = 'disconnect'"
        />
        <MatrixSetupStepper
          v-else
          :key="bridge.id"
          :bridge="bridge"
          :harmony-channels="channels"
          :encrypted-channel-ids="encryptedChannelIds"
          :now="now"
          :harmony-url="harmonyUrl"
          @state="apply"
          @finish="finish"
          @start-over="confirm = 'startOver'"
        />

        <details class="db-details own-program" :open="customOpen" data-testid="matrix-custom-more" @toggle="onCustomToggle">
          <summary>{{ t('matrixBridge.custom.beside') }}</summary>
          <p class="db-muted">{{ t('matrixBridge.custom.besideLead') }}</p>
          <MatrixCustomBridge v-if="customOpen" :server-id="serverId" :managed-bot-id="bridge.bot_id" :hide-privacy="view === 'status'" />
        </details>
      </template>
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
import { computed, nextTick, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useChannelEncryptionStore } from '@/stores/useChannelEncryption'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ConfirmationModal from '@/components/ConfirmationModal.vue'
import { debug } from '@/utils/debug'
import { resolveHarmonyBaseUrl, resolveInstanceName, type BridgeMode, type HarmonyChannelOption } from '@/utils/discordBridgeSetup'
import { MATRIX_REMOVE_COMMAND, type MatrixBridgeState } from '@/utils/matrixBridgeSetup'
import { BridgeUnavailableError, fetchServerChannels } from '@/components/settings/discord-bridge/bridgeApi'
import { useBridgePolling } from '@/components/settings/discord-bridge/useBridgePolling'
import BridgeModeChooser from '@/components/settings/discord-bridge/BridgeModeChooser.vue'
import MatrixCustomBridge from './MatrixCustomBridge.vue'
import MatrixSetupStepper from './MatrixSetupStepper.vue'
import MatrixStatusView from './MatrixStatusView.vue'
import { fetchServerMatrixBridges } from './matrixBridgeApi'
import {
  createMatrixBridge,
  deleteMatrixBridge,
  fetchMatrixBridgeState,
  fetchMatrixOffers,
  matrixManagedErrorKey,
  type MatrixOffers,
} from './matrixManagedApi'

const props = defineProps<{ serverId: string }>()

const { t } = useI18n()
const toast = useToast()
const encryption = useChannelEncryptionStore()
const uid = `matrix-bridge-${useId()}`
const harmonyUrl = resolveHarmonyBaseUrl()
const instanceName = resolveInstanceName()
const heading = ref<HTMLElement | null>(null)

const loading = ref(true)
const loadError = ref(false)
const busy = ref(false)
const actionError = ref('')

const bridge = ref<MatrixBridgeState | null>(null)
const channels = ref<HarmonyChannelOption[]>([])
/** False on an instance before 1.9.9, which knows bridge programs with a bot of their own only. */
const managedOffered = ref(true)
const view = ref<'chooser' | 'custom' | 'setup' | 'status'>('chooser')
/** The server has channels paired by a bot of someone's own. */
const pairedByHand = ref(false)
const customOpen = ref(false)
const confirm = ref<'disconnect' | 'startOver' | null>(null)
const offers = ref<MatrixOffers>({ hosted: false, instance: false })
/** The program a self-run bridge leaves on someone's computer. */
const confirmNote = computed(() =>
  confirm.value && bridge.value?.mode === 'self' ? t('matrixBridge.managed.confirmNote', { command: MATRIX_REMOVE_COMMAND }) : '',
)

const encryptedChannelIds = computed(() => channels.value.map((c) => c.id).filter((id) => encryption.isMessagesEncrypted(id)))

let refreshSeq = 0
const { now } = useBridgePolling(() => !!bridge.value && !loading.value, () => void refresh())

async function load() {
  const seq = ++refreshSeq
  loading.value = true
  loadError.value = false
  actionError.value = ''
  const [state, serverChannels, custom, offered] = await Promise.allSettled([
    fetchMatrixBridgeState(props.serverId),
    fetchServerChannels(props.serverId),
    fetchServerMatrixBridges(props.serverId),
    fetchMatrixOffers(),
  ])
  if (seq !== refreshSeq) return
  managedOffered.value = !(state.status === 'rejected' && state.reason instanceof BridgeUnavailableError)
  bridge.value = state.status === 'fulfilled' ? state.value : null
  channels.value = serverChannels.status === 'fulfilled' ? serverChannels.value : []
  if (offered.status === 'fulfilled') offers.value = offered.value
  pairedByHand.value = custom.status === 'fulfilled' && custom.value.length > 0
  const failed = [state, serverChannels, custom].find(
    (result) => result.status === 'rejected' && !(result.reason instanceof BridgeUnavailableError),
  )
  // MatrixCustomBridge loads and reports for itself.
  if (failed && (bridge.value ? serverChannels.status === 'rejected' : managedOffered.value)) {
    debug.error('Matrix bridge load failed:', (failed as PromiseRejectedResult).reason)
    loadError.value = true
  }
  if (bridge.value) view.value = bridge.value.pairs.length ? 'status' : 'setup'
  else leave()
  customOpen.value = pairedByHand.value
  now.value = Date.now()
  loading.value = false
  if (bridge.value) loadEncryption()
}

/** What a server without a managed bridge shows. */
function leave() {
  view.value = pairedByHand.value || !managedOffered.value ? 'custom' : 'chooser'
}

function loadEncryption() {
  void encryption.loadServer(props.serverId, channels.value.map((c) => c.id))
}

async function refresh() {
  const seq = ++refreshSeq
  try {
    const state = await fetchMatrixBridgeState(props.serverId)
    if (seq !== refreshSeq) return
    bridge.value = state
    // Removed elsewhere.
    if (!state) leave()
    now.value = Date.now()
  } catch (error) {
    debug.warn('Matrix bridge refresh failed:', error)
  }
}

/** A write's answer; a read started before it is dropped. */
function apply(state: MatrixBridgeState) {
  refreshSeq++
  bridge.value = state
  now.value = Date.now()
}

async function show(target: 'chooser' | 'custom') {
  actionError.value = ''
  view.value = target
  await nextTick()
  heading.value?.focus()
}

async function create(mode: BridgeMode) {
  busy.value = true
  actionError.value = ''
  try {
    apply(await createMatrixBridge(props.serverId, mode))
    view.value = 'setup'
    loadEncryption()
  } catch (error) {
    debug.error('matrix_bridge_create failed:', error)
    actionError.value = t(matrixManagedErrorKey(error, 'discordBridge.errors.create', 'matrixBridge.errors.exists'))
  } finally {
    busy.value = false
  }
}

function finish() {
  view.value = 'status'
  toast.success(t('discordBridge.status.finished'))
}

function onCustomToggle(event: Event) {
  customOpen.value = (event.target as HTMLDetailsElement).open
}

async function runDelete() {
  const row = bridge.value
  const kind = confirm.value
  confirm.value = null
  if (!row) return
  busy.value = true
  actionError.value = ''
  try {
    await deleteMatrixBridge(row.id)
    try {
      localStorage.removeItem(`harmony.matrixBridge.reached.${row.id}`)
    } catch {
      /* storage unavailable */
    }
    refreshSeq++
    bridge.value = null
    leave()
    if (kind === 'disconnect') toast.success(t('discordBridge.status.disconnected'))
  } catch (error) {
    debug.error('matrix_bridge_delete failed:', error)
    actionError.value = t(matrixManagedErrorKey(error, 'discordBridge.errors.delete'))
  } finally {
    busy.value = false
  }
}

onMounted(() => void load())
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.matrix-bridge {
  margin-bottom: 32px;
  max-width: 860px;
}

.settings-section {
  margin-bottom: 20px;
}

.section-title {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-title:focus {
  outline: none;
}

.section-title:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
  border-radius: 4px;
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

.other-ways {
  text-align: center;
}

.own-program {
  margin-top: 16px;
}
</style>
