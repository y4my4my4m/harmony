<template>
  <div data-testid="matrix-room-code">
    <div v-if="linked" class="db-banner db-banner--success" role="status" data-testid="matrix-linked">
      <p>{{ linked }}</p>
    </div>

    <form ref="formEl" class="add-form" novalidate data-testid="pair-form" @submit.prevent="issue">
      <h4 class="db-card-sub">{{ t('matrixBridge.link.title') }}</h4>
      <div class="add-grid">
        <BridgeChannelSelect
          :id="`${uid}-harmony`"
          v-model="channelId"
          :groups="channelGroups"
          :encrypted-ids="encryptedChannelIds"
          :describedby="`${uid}-encrypted`"
        />
        <div class="db-field">
          <label :for="`${uid}-direction`" class="db-label">{{ t('discordBridge.pairs.directionLabel') }}</label>
          <select :id="`${uid}-direction`" v-model="direction" class="db-select" data-testid="select-direction">
            <option v-for="d in MATRIX_PAIR_DIRECTIONS" :key="d" :value="d">{{ t(`matrixBridge.managed.direction.${d}`) }}</option>
          </select>
        </div>
        <div v-if="ghosts" class="db-field">
          <label :for="`${uid}-mode`" class="db-label">{{ t('matrixBridge.pairs.senderMode') }}</label>
          <select :id="`${uid}-mode`" v-model="senderMode" class="db-select" data-testid="select-mode">
            <option v-for="mode in MATRIX_SENDER_MODES" :key="mode" :value="mode">{{ t(`matrixBridge.pairs.mode.${mode}`) }}</option>
          </select>
        </div>
      </div>
      <p :id="`${uid}-encrypted`" class="db-muted" data-testid="matrix-encrypted-note">{{ t('matrixBridge.link.encryptedNote') }}</p>
      <p v-if="channelGroups.length === 0" class="db-muted" data-testid="no-harmony-left">{{ t('discordBridge.pairs.noHarmonyLeft') }}</p>
      <p v-if="formError" class="db-field-error" role="alert" data-testid="pair-error">{{ formError }}</p>
      <div v-if="!issued" class="db-actions">
        <button type="submit" class="btn btn-primary" :disabled="busy" data-testid="get-room-code">{{ t('matrixBridge.link.getCode') }}</button>
      </div>
    </form>

    <section v-if="issued" class="code-panel" :aria-labelledby="`${uid}-code`" data-testid="matrix-code-panel">
      <h4 :id="`${uid}-code`" ref="codeTitle" class="db-card-sub" tabindex="-1">{{ t('matrixBridge.link.codeTitle', { channel: issuedChannel }) }}</h4>
      <ol class="db-steps">
        <li>
          {{ t('matrixBridge.link.invite') }}
          <BridgeCopyBlock v-if="account" :text="account" :label="t('matrixBridge.managed.account')" data-testid="matrix-code-account" />
          <p v-else class="db-muted" data-testid="matrix-code-no-account">{{ t('matrixBridge.link.noAccount') }}</p>
        </li>
        <li>
          {{ t('matrixBridge.link.post') }}
          <BridgeCopyBlock :text="command" :label="t('matrixBridge.link.command')" data-testid="matrix-code-command" />
          <span :class="['db-badge', expired ? 'db-badge--error' : '']" data-testid="matrix-code-expiry">
            {{ expired ? t('discordBridge.self.codeExpired') : t('discordBridge.self.codeExpires', { count: remaining }, remaining) }}
          </span>
        </li>
        <li>{{ t('matrixBridge.link.appears') }}</li>
      </ol>
      <div v-if="expired" class="db-banner db-banner--warn" role="alert" data-testid="matrix-code-expired">
        <p>{{ t('matrixBridge.link.expiredHelp') }}</p>
      </div>
      <p class="db-muted">{{ t('matrixBridge.link.who') }}</p>
      <p class="db-muted">{{ t('matrixBridge.link.moves') }}</p>
      <div class="db-actions">
        <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" data-testid="new-room-code" @click="issue">
          <Icon name="refresh-cw" :size="14" aria-hidden="true" />
          {{ t('discordBridge.self.newCode') }}
        </button>
        <button type="button" class="btn btn-ghost btn-sm" data-testid="close-room-code" @click="issued = null">
          {{ t('matrixBridge.link.close') }}
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import { SETUP_CODE_TTL_MS, groupHarmonyTextChannels, type HarmonyChannelOption } from '@/utils/discordBridgeSetup'
import {
  MATRIX_PAIR_DIRECTIONS,
  MATRIX_SENDER_MODES,
  matrixPairLostRoom,
  matrixPairRoom,
  matrixRoomLabel,
  type MatrixBridgeState,
  type MatrixPairDirection,
  type MatrixSenderMode,
} from '@/utils/matrixBridgeSetup'
import BridgeChannelSelect from '@/components/settings/discord-bridge/BridgeChannelSelect.vue'
import BridgeCopyBlock from '@/components/settings/discord-bridge/BridgeCopyBlock.vue'
import { minutesLeft } from '@/components/settings/discord-bridge/bridgeTime'
import { createMatrixRoomCode, matrixManagedErrorKey, type MatrixRoomCode } from './matrixManagedApi'

const props = defineProps<{
  bridge: MatrixBridgeState
  harmonyChannels: HarmonyChannelOption[]
  encryptedChannelIds: string[]
  now: number
}>()

const { t } = useI18n()
const uid = `matrix-code-${useId()}`
const formEl = ref<HTMLFormElement | null>(null)
const codeTitle = ref<HTMLElement | null>(null)

const channelId = ref('')
const direction = ref<MatrixPairDirection>('both')
const senderMode = ref<MatrixSenderMode>('ghost')
const busy = ref(false)
const formError = ref('')
const issued = ref<(MatrixRoomCode & { channelId: string }) | null>(null)
const linked = ref('')

const ghosts = computed(() => props.bridge.connection === 'application_service')
/** A pair that lost its room takes a code for the same channel. */
const channelGroups = computed(() =>
  groupHarmonyTextChannels(
    props.harmonyChannels,
    new Set(props.bridge.pairs.filter((pair) => !matrixPairLostRoom(props.bridge, pair)).map((pair) => pair.channel_id)),
  ),
)
const account = computed(() => issued.value?.userId ?? props.bridge.status.userId)
const command = computed(() => (issued.value ? `!harmony link ${issued.value.code}` : ''))
/** `now` is up to a poll older than a code. */
const remaining = computed(() =>
  issued.value ? minutesLeft(issued.value.issuedAt + SETUP_CODE_TTL_MS, Math.max(props.now, issued.value.issuedAt)) : 0,
)
const expired = computed(() => remaining.value === 0)

const channelName = (id: string) => {
  const channel = props.harmonyChannels.find((c) => c.id === id)
  return channel ? `#${channel.name}` : t('matrixBridge.managed.hiddenChannel')
}
const issuedChannel = computed(() => (issued.value ? channelName(issued.value.channelId) : ''))

watch([channelId, direction], () => { formError.value = '' })
// A code carries the channel, the direction and the sender mode it was made with.
watch(channelId, (id) => {
  if (id) linked.value = ''
  if (issued.value && id && id !== issued.value.channelId) issued.value = null
  const lost = props.bridge.pairs.find((pair) => pair.channel_id === id)
  if (lost) {
    direction.value = lost.direction
    senderMode.value = lost.sender_mode
  }
})
watch([direction, senderMode], () => { issued.value = null })

watch(
  () => props.bridge.pairs.find((pair) => pair.channel_id === issued.value?.channelId && !matrixPairLostRoom(props.bridge, pair)),
  (pair) => {
    if (!pair) return
    linked.value = t('matrixBridge.link.linked', {
      channel: channelName(pair.channel_id),
      room: matrixRoomLabel(props.bridge.rooms, matrixPairRoom(pair)),
    })
    issued.value = null
    channelId.value = ''
    direction.value = 'both'
  },
)

async function issue() {
  formError.value = ''
  const id = issued.value?.channelId ?? channelId.value
  if (!id) {
    formError.value = t('matrixBridge.link.chooseChannel')
    return
  }
  busy.value = true
  try {
    const code = await createMatrixRoomCode(props.bridge.id, id, direction.value, ghosts.value || !props.bridge.connection ? senderMode.value : 'relay')
    const first = !issued.value
    issued.value = { ...code, channelId: id }
    linked.value = ''
    if (first) {
      await nextTick()
      codeTitle.value?.focus()
    }
  } catch (error) {
    debug.error('matrix_bridge_room_code failed:', error)
    formError.value = t(matrixManagedErrorKey(error, 'matrixBridge.errors.roomCode'))
  } finally {
    busy.value = false
  }
}

async function start(id: string) {
  channelId.value = id
  await nextTick()
  formEl.value?.scrollIntoView?.({ block: 'nearest' })
  formEl.value?.querySelector<HTMLSelectElement>('select')?.focus()
}

defineExpose({ start })
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.code-panel {
  margin-top: 12px;
  padding: 14px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 45%, var(--background-quaternary));
}

.code-panel h4:focus {
  outline: none;
}

.code-panel h4:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
  border-radius: 4px;
}

.db-steps .db-code-block {
  margin: 8px 0;
}
</style>
