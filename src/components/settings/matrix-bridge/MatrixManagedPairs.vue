<template>
  <div data-testid="matrix-managed-pairs">
    <p class="db-muted">{{ t('matrixBridge.managed.pairsLead') }}</p>
    <p v-if="!instance" class="db-muted" data-testid="matrix-invite-hint">
      <i18n-t v-if="bridge.status.userId" keypath="matrixBridge.managed.inviteHint" tag="span" scope="global">
        <template #account><code class="db-inline-code">{{ bridge.status.userId }}</code></template>
      </i18n-t>
      <template v-else>{{ t('matrixBridge.managed.inviteHintUnknown') }}</template>
    </p>

    <p v-if="bridge.pairs.length === 0" class="db-text empty" data-testid="pairs-empty">{{ t('matrixBridge.pairs.empty') }}</p>
    <ul v-else class="pair-list" :aria-label="t('matrixBridge.pairs.listLabel')">
      <li
        v-for="row in rows"
        :key="row.pair.channel_id"
        class="pair"
        data-testid="matrix-managed-pair"
        :data-channel="row.pair.channel_id"
        :data-state="row.state"
      >
        <div class="pair-main">
          <span class="pair-channel">
            <span class="pair-platform">{{ t('matrixBridge.pairs.harmony') }}</span>
            <span class="pair-name">{{ row.channel }}</span>
          </span>
          <span class="pair-arrow" aria-hidden="true">{{ ARROWS[row.pair.direction] }}</span>
          <span class="pair-channel">
            <span class="pair-platform">{{ t('matrixBridge.pairs.matrix') }}</span>
            <span class="pair-name" data-testid="matrix-pair-room">{{ row.room }}</span>
            <span v-if="row.address !== row.room" class="pair-address">{{ row.address }}</span>
          </span>
        </div>

        <div class="pair-meta">
          <span :class="['db-badge', BADGE[row.state]]" data-testid="matrix-pair-badge">
            {{ t(`matrixBridge.managed.state.${row.state}`) }}
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-sm remove"
            :disabled="busy"
            :aria-label="t('matrixBridge.managed.removeLabel', { channel: row.channel, room: row.room })"
            data-testid="pair-remove"
            @click="remove(row.pair)"
          >
            <Icon name="trash-2" :size="14" aria-hidden="true" />
            <span>{{ t('discordBridge.pairs.remove') }}</span>
          </button>
        </div>

        <p v-if="row.state === 'error'" class="pair-fix" data-testid="matrix-pair-error">{{ pairError(row) }}</p>

        <div v-if="row.lost" class="db-actions pair-relink">
          <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" data-testid="pair-relink" @click="codeForm?.start(row.pair.channel_id)">
            {{ t('matrixBridge.link.again') }}
          </button>
        </div>
        <div v-else-if="row.known" class="pair-options">
          <div class="db-field">
            <label class="db-label" :for="`${uid}-${row.pair.channel_id}-direction`">{{ t('discordBridge.pairs.directionLabel') }}</label>
            <select
              :id="`${uid}-${row.pair.channel_id}-direction`"
              class="db-select"
              :value="row.pair.direction"
              :disabled="busy"
              data-testid="matrix-pair-direction"
              @change="change(row.pair, $event, 'direction')"
            >
              <option v-for="d in MATRIX_PAIR_DIRECTIONS" :key="d" :value="d">{{ t(`matrixBridge.managed.direction.${d}`) }}</option>
            </select>
          </div>
          <div v-if="appService" class="db-field">
            <label class="db-label" :for="`${uid}-${row.pair.channel_id}-mode`">{{ t('matrixBridge.pairs.senderMode') }}</label>
            <select
              :id="`${uid}-${row.pair.channel_id}-mode`"
              class="db-select"
              :value="row.pair.sender_mode"
              :disabled="busy"
              :aria-describedby="`${uid}-${row.pair.channel_id}-mode-hint`"
              data-testid="matrix-pair-mode"
              @change="change(row.pair, $event, 'sender_mode')"
            >
              <option v-for="mode in MATRIX_SENDER_MODES" :key="mode" :value="mode">{{ t(`matrixBridge.pairs.mode.${mode}`) }}</option>
            </select>
            <p :id="`${uid}-${row.pair.channel_id}-mode-hint`" class="db-muted mode-hint">{{ t(`matrixBridge.pairs.modeHint.${row.pair.sender_mode}`) }}</p>
          </div>
        </div>
        <p v-if="saving === row.pair.channel_id" class="db-muted saving" role="status">{{ t('matrixBridge.pairs.saving') }}</p>
      </li>
    </ul>

    <p v-if="listError" class="db-field-error list-error" role="alert" data-testid="matrix-pairs-error">{{ listError }}</p>

    <MatrixRoomCode
      v-if="instance"
      ref="codeForm"
      :bridge="bridge"
      :harmony-channels="harmonyChannels"
      :encrypted-channel-ids="encryptedChannelIds"
      :now="now"
    />

    <form v-else class="add-form" novalidate data-testid="pair-form" @submit.prevent="add">
      <h4 class="db-card-sub">{{ t('discordBridge.pairs.addTitle') }}</h4>
      <div class="add-grid">
        <BridgeChannelSelect
          :id="`${uid}-harmony`"
          v-model="channelId"
          :groups="channelGroups"
          :encrypted-ids="encryptedChannelIds"
          :describedby="`${uid}-encrypted`"
        />

        <div v-if="offeredRooms.length" class="db-field">
          <label :for="`${uid}-room`" class="db-label">{{ t('matrixBridge.managed.room') }}</label>
          <select :id="`${uid}-room`" v-model="roomChoice" class="db-select" :aria-describedby="`${uid}-encrypted`" data-testid="select-room">
            <option value="">{{ t('discordBridge.pairs.choose') }}</option>
            <option v-for="room in joinedRooms" :key="room.room_id" :value="room.room_id" :disabled="!!matrixRoomIssue(room, direction)">{{ roomLabel(room) }}</option>
            <optgroup v-if="invitedRooms.length" :label="t('matrixBridge.managed.invitations')">
              <option v-for="room in invitedRooms" :key="room.room_id" :value="room.room_id" :disabled="!!matrixRoomIssue(room, direction)">{{ roomLabel(room) }}</option>
            </optgroup>
            <option :value="OTHER_ROOM">{{ t('matrixBridge.managed.otherRoom') }}</option>
          </select>
        </div>

        <div v-if="typing" class="db-field wide">
          <label :for="`${uid}-address`" class="db-label">{{ t('matrixBridge.managed.address') }}</label>
          <input
            :id="`${uid}-address`"
            v-model="address"
            class="db-input"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            maxlength="512"
            placeholder="#general:example.org"
            :aria-invalid="addressError ? 'true' : undefined"
            :aria-describedby="`${uid}-address-help`"
            data-testid="room-address"
          />
          <p :id="`${uid}-address-help`" :class="addressError ? 'db-field-error' : 'db-muted field-help'" data-testid="room-address-help">
            {{ addressError || t('matrixBridge.managed.addressHelp') }}
          </p>
        </div>

        <div class="db-field">
          <label :for="`${uid}-direction`" class="db-label">{{ t('discordBridge.pairs.directionLabel') }}</label>
          <select :id="`${uid}-direction`" v-model="direction" class="db-select" data-testid="select-direction">
            <option v-for="d in MATRIX_PAIR_DIRECTIONS" :key="d" :value="d">{{ t(`matrixBridge.managed.direction.${d}`) }}</option>
          </select>
        </div>

        <div v-if="appService" class="db-field wide">
          <label :for="`${uid}-mode`" class="db-label">{{ t('matrixBridge.pairs.senderMode') }}</label>
          <select :id="`${uid}-mode`" v-model="senderMode" class="db-select" data-testid="select-mode">
            <option v-for="mode in MATRIX_SENDER_MODES" :key="mode" :value="mode">{{ t(`matrixBridge.pairs.mode.${mode}`) }}</option>
          </select>
        </div>
      </div>

      <p :id="`${uid}-encrypted`" class="db-muted" data-testid="matrix-encrypted-note">{{ t('matrixBridge.managed.encryptedNote') }}</p>
      <p v-if="channelGroups.length === 0" class="db-muted" data-testid="no-harmony-left">{{ t('discordBridge.pairs.noHarmonyLeft') }}</p>
      <p v-if="!isOnline" class="db-muted" data-testid="matrix-rooms-stale">{{ t('matrixBridge.managed.roomsStale') }}</p>
      <p v-if="formError" class="db-field-error" role="alert" data-testid="pair-error">{{ formError }}</p>

      <div class="db-actions">
        <button type="submit" class="btn btn-primary" :disabled="busy" data-testid="pair-add">
          <Icon name="plus" :size="14" aria-hidden="true" />
          {{ t('discordBridge.pairs.add') }}
        </button>
      </div>
    </form>

    <details v-if="appService" class="db-details modes" data-testid="matrix-modes">
      <summary>{{ t('matrixBridge.modes.title') }}</summary>
      <p class="db-muted">{{ t('matrixBridge.managed.ghostExplained') }}</p>
      <p class="db-muted">{{ t('matrixBridge.modes.relay') }}</p>
      <p class="db-muted">{{ t('matrixBridge.modes.future') }}</p>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import { groupHarmonyTextChannels, isBridgeOnline, type HarmonyChannelOption } from '@/utils/discordBridgeSetup'
import {
  MATRIX_PAIR_DIRECTIONS,
  MATRIX_SENDER_MODES,
  matrixPairLostRoom,
  matrixPairRoom,
  matrixRoomIssue,
  matrixRoomName,
  parseMatrixRoomInput,
  type MatrixBridgeState,
  type MatrixManagedPair,
  type MatrixPairDirection,
  type MatrixPairState,
  type MatrixRoom,
  type MatrixSenderMode,
} from '@/utils/matrixBridgeSetup'
import BridgeChannelSelect from '@/components/settings/discord-bridge/BridgeChannelSelect.vue'
import MatrixRoomCode from './MatrixRoomCode.vue'
import { matrixManagedErrorKey, pairMatrixRoom, unpairMatrixRoom } from './matrixManagedApi'

const props = defineProps<{
  bridge: MatrixBridgeState
  harmonyChannels: HarmonyChannelOption[]
  /** Channels whose messages are end-to-end encrypted: listed, not offered. */
  encryptedChannelIds: string[]
  now: number
}>()

const emit = defineEmits<{ state: [state: MatrixBridgeState] }>()

/** The room select's value for a typed room; no Matrix room id, which begins with '!'. */
const OTHER_ROOM = 'other'
const ARROWS: Record<MatrixPairDirection, string> = { both: '⇄', to_harmony: '←', to_matrix: '→' }
const BADGE: Record<MatrixPairState | 'new', string> = { ready: 'db-badge--ok', joining: '', new: '', error: 'db-badge--error' }

/** bridge_channels.state_error values worded under matrixBridge.pairError; others are the bridge's own words. */
const PAIR_ERRORS = new Set([
  'room_not_found',
  'not_invited',
  'room_encrypted',
  'channel_encrypted',
  'cannot_send',
  'room_in_use',
  'ghosts_unavailable',
  'harmony_not_bound',
])

const { t } = useI18n()
const uid = `matrix-pairs-${useId()}`

const channelId = ref('')
const roomChoice = ref('')
const address = ref('')
const addressError = ref('')
const direction = ref<MatrixPairDirection>('both')
const senderMode = ref<MatrixSenderMode>('ghost')
const busy = ref(false)
const saving = ref<string | null>(null)
const formError = ref('')
const listError = ref('')

const codeForm = ref<{ start: (channelId: string) => void } | null>(null)

/** Rooms are linked by a code posted in them. */
const instance = computed(() => props.bridge.mode === 'instance')
const appService = computed(() => props.bridge.connection === 'application_service')
const isOnline = computed(() => isBridgeOnline(props.bridge.last_seen_at, props.now))

const rows = computed(() =>
  props.bridge.pairs.map((pair) => {
    const channel = props.harmonyChannels.find((c) => c.id === pair.channel_id)
    const named = matrixPairRoom(pair)
    const room = props.bridge.rooms.find((r) => r.room_id === pair.room_id)
    return {
      pair,
      known: !!channel,
      lost: matrixPairLostRoom(props.bridge, pair),
      state: (matrixPairLostRoom(props.bridge, pair) ? 'error' : (pair.state ?? 'new')) as MatrixPairState | 'new',
      channel: channel ? `#${channel.name}` : t('matrixBridge.managed.hiddenChannel'),
      room: room ? matrixRoomName(room) : named || t('matrixBridge.managed.noRoom'),
      address: pair.room_alias ?? room?.alias ?? (named || t('matrixBridge.managed.noRoom')),
    }
  }),
)

const channelGroups = computed(() =>
  groupHarmonyTextChannels(props.harmonyChannels, new Set(props.bridge.pairs.map((pair) => pair.channel_id))),
)

const offeredRooms = computed(() => {
  const paired = new Set(props.bridge.pairs.flatMap((pair) => [pair.room_id, pair.room_alias]))
  return props.bridge.rooms.filter((room) => !paired.has(room.room_id) && !(room.alias && paired.has(room.alias)))
})
const joinedRooms = computed(() => offeredRooms.value.filter((room) => !room.invited))
const invitedRooms = computed(() => offeredRooms.value.filter((room) => room.invited))
const typing = computed(() => !offeredRooms.value.length || roomChoice.value === OTHER_ROOM)

function roomLabel(room: MatrixRoom): string {
  const issue = matrixRoomIssue(room, direction.value)
  const name = matrixRoomName(room)
  if (issue) {
    const reason = issue === 'encrypted' ? t('bridges.encrypted') : t('matrixBridge.managed.cannotSend')
    return t('matrixBridge.managed.roomOption', { name, detail: reason })
  }
  return room.alias && room.alias !== name ? t('matrixBridge.managed.roomOption', { name, detail: room.alias }) : name
}

function pairError(row: { pair: MatrixManagedPair; lost: boolean; room: string; channel: string }): string {
  if (row.lost) return t('matrixBridge.pairError.room_moved', { channel: row.channel })
  const code = row.pair.state_error
  if (!code) return t('matrixBridge.pairError.unknown')
  if (!PAIR_ERRORS.has(code)) return code
  return t(`matrixBridge.pairError.${code}`, {
    room: row.room,
    channel: row.channel,
    account: props.bridge.status.userId ?? t('matrixBridge.managed.theAccount'),
  })
}

watch([channelId, roomChoice, address, direction], () => {
  formError.value = ''
  addressError.value = ''
})
// A chosen room that can no longer be offered (paired, encrypted, unwritable) is dropped.
watch([offeredRooms, direction], () => {
  if (!roomChoice.value || roomChoice.value === OTHER_ROOM) return
  const room = offeredRooms.value.find((r) => r.room_id === roomChoice.value)
  if (!room || matrixRoomIssue(room, direction.value)) roomChoice.value = ''
})

/** The room the form names; null after saying what is missing. */
function chosenRoom(): string | null {
  if (!typing.value) {
    if (!roomChoice.value) formError.value = t('matrixBridge.managed.chooseBoth')
    return roomChoice.value || null
  }
  const room = parseMatrixRoomInput(address.value)
  if (!room) {
    addressError.value = t(address.value.trim() ? 'matrixBridge.managed.addressInvalid' : 'matrixBridge.managed.addressEmpty')
    return null
  }
  const listed = props.bridge.rooms.find((r) => r.room_id === room || r.alias === room)
  if (listed?.encrypted) {
    addressError.value = t('matrixBridge.pairError.room_encrypted', { room: matrixRoomName(listed) })
    return null
  }
  return room
}

async function add() {
  formError.value = ''
  addressError.value = ''
  if (!channelId.value) {
    formError.value = t('matrixBridge.managed.chooseBoth')
    return
  }
  const room = chosenRoom()
  if (!room) return
  busy.value = true
  listError.value = ''
  try {
    const state = await pairMatrixRoom(props.bridge.id, channelId.value, room, direction.value, appService.value ? senderMode.value : 'relay')
    channelId.value = ''
    roomChoice.value = ''
    address.value = ''
    direction.value = 'both'
    emit('state', state)
  } catch (error) {
    debug.error('matrix_bridge_pair failed:', error)
    formError.value = t(matrixManagedErrorKey(error, 'discordBridge.errors.pair', 'matrixBridge.errors.roomTaken'))
  } finally {
    busy.value = false
  }
}

async function remove(pair: MatrixManagedPair) {
  busy.value = true
  listError.value = ''
  try {
    emit('state', await unpairMatrixRoom(props.bridge.id, pair.channel_id))
  } catch (error) {
    debug.error('matrix_bridge_unpair failed:', error)
    listError.value = t(matrixManagedErrorKey(error, 'discordBridge.errors.unpair'))
  } finally {
    busy.value = false
  }
}

/** The select shows the saved value until the server confirms another. */
async function change(pair: MatrixManagedPair, event: Event, field: 'direction' | 'sender_mode') {
  const select = event.target as HTMLSelectElement
  const value = select.value
  select.value = pair[field]
  if (busy.value) return
  const next = { ...pair, [field]: value }
  busy.value = true
  saving.value = pair.channel_id
  listError.value = ''
  try {
    emit('state', await pairMatrixRoom(props.bridge.id, pair.channel_id, matrixPairRoom(pair), next.direction, next.sender_mode))
  } catch (error) {
    debug.error('matrix_bridge_pair failed:', error)
    listError.value = t(matrixManagedErrorKey(error, 'matrixBridge.errors.change', 'matrixBridge.errors.roomTaken'))
  } finally {
    busy.value = false
    saving.value = null
  }
}
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.empty {
  color: var(--text-secondary);
}

.pair-address {
  font-size: 12px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.pair-fix {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.add-grid .wide {
  grid-column: span 2;
}

.pair-relink {
  margin-top: 10px;
}

.pair-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 12px;
  margin-top: 12px;
}

.pair-options .db-field {
  margin-bottom: 0;
}

.mode-hint,
.field-help {
  margin: 0;
}

.saving {
  margin: 6px 0 0;
}

.list-error {
  margin-bottom: 12px;
}

.modes {
  margin-top: 16px;
}

.modes .db-muted:last-child {
  margin-bottom: 0;
}

@media (max-width: 720px) {
  .add-grid .wide {
    grid-column: auto;
  }

  .pair-options {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
