<template>
  <form class="matrix-setup" novalidate data-testid="matrix-setup" :aria-labelledby="`${uid}-title`" @submit.prevent="submit">
    <h4 :id="`${uid}-title`" ref="titleEl" class="db-card-sub" tabindex="-1">
      {{ t(editing ? 'matrixBridge.setup.editTitle' : 'matrixBridge.setup.title') }}
    </h4>
    <p class="db-muted">{{ t('matrixBridge.setup.lead') }}</p>

    <div class="db-field bot-field">
      <label class="db-label" :for="`${uid}-bot`">{{ t('matrixBridge.setup.bot') }}</label>
      <select :id="`${uid}-bot`" v-model="botId" class="db-select" :disabled="busy" data-testid="matrix-setup-bot">
        <option v-for="install in installs" :key="install.bot_id" :value="install.bot_id">{{ install.bot_display_name }}</option>
      </select>
    </div>

    <fieldset class="channel-pick" :disabled="busy" :aria-describedby="hasBlocked ? `${uid}-help` : undefined">
      <legend class="db-label">{{ t('matrixBridge.setup.channels') }}</legend>
      <p v-if="!channels.length" class="db-muted">{{ t('matrixBridge.setup.noChannels') }}</p>
      <ul v-else class="channel-list">
        <li v-for="channel in channels" :key="channel.id">
          <label :class="['channel-option', { blocked: !allowed.has(channel.id) }]" data-testid="matrix-setup-channel" :data-channel="channel.id">
            <input
              v-model="picked"
              type="checkbox"
              :value="channel.id"
              :disabled="!allowed.has(channel.id)"
              :aria-describedby="allowed.has(channel.id) ? undefined : `${uid}-help`"
            />
            <span class="channel-name">#{{ channel.name }}</span>
            <span v-if="channel.categoryName" class="channel-category">{{ channel.categoryName }}</span>
            <span v-if="!allowed.has(channel.id)" class="channel-note" data-testid="matrix-setup-channel-note">
              {{ t('matrixBridge.setup.notAllowed', { bot: botName }) }}
            </span>
          </label>
        </li>
      </ul>
    </fieldset>
    <p v-if="hasBlocked" :id="`${uid}-help`" class="db-muted" data-testid="matrix-setup-allowlist-help">
      {{ t('matrixBridge.setup.notAllowedHelp', { bot: botName }) }}
    </p>

    <p v-if="shownError" class="db-field-error" role="alert" data-testid="matrix-setup-error">{{ shownError }}</p>

    <div class="db-actions">
      <button type="submit" class="btn btn-primary" :disabled="busy" data-testid="matrix-setup-save">
        {{ busy ? t('matrixBridge.setup.saving') : t(editing ? 'matrixBridge.setup.saveEdit' : 'matrixBridge.setup.save') }}
      </button>
      <button v-if="editing" type="button" class="btn btn-ghost" :disabled="busy" data-testid="matrix-setup-cancel" @click="emit('cancel')">
        {{ t('matrixBridge.setup.cancel') }}
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HarmonyChannelOption } from '@/utils/discordBridgeSetup'
import type { MatrixBotInstall } from './matrixBridgeApi'

const props = withDefaults(defineProps<{
  /** Bots that can bridge; never empty. */
  installs: MatrixBotInstall[]
  /** The server's text channels in sidebar order. */
  channels: HarmonyChannelOption[]
  /** Channels each bot bridges in this server now. */
  bound?: Record<string, string[]>
  initialBotId?: string | null
  editing?: boolean
  busy?: boolean
  /** A failed save, already translated. */
  error?: string
  autofocus?: boolean
}>(), { bound: () => ({}), initialBotId: null, editing: false, busy: false, error: '', autofocus: false })

const emit = defineEmits<{ save: [botId: string, channelIds: string[]]; cancel: [] }>()

const { t } = useI18n()
const uid = `matrix-setup-${useId()}`
const titleEl = ref<HTMLElement | null>(null)

const botId = ref(
  props.installs.some(install => install.bot_id === props.initialBotId) ? props.initialBotId! : props.installs[0]?.bot_id ?? '',
)
const install = computed(() => props.installs.find(item => item.bot_id === botId.value) ?? null)
const botName = computed(() => install.value?.bot_display_name ?? '')
const allowed = computed(() => new Set(install.value?.allowed_channel_ids ?? []))
const hasBlocked = computed(() => props.channels.some(channel => !allowed.value.has(channel.id)))

const picked = ref<string[]>([])
const pickError = ref(false)
const shownError = computed(() => (pickError.value ? t(props.editing ? 'matrixBridge.setup.pickOneEdit' : 'matrixBridge.setup.pickOne') : props.error))

/** A bot's current channels, as far as its channel list still admits them. */
watch(botId, (id) => {
  picked.value = (props.bound[id] ?? []).filter(channelId => allowed.value.has(channelId))
  pickError.value = false
}, { immediate: true })
watch(picked, () => { pickError.value = false })

function submit() {
  if (props.busy || !install.value) return
  const ids = props.channels.map(channel => channel.id).filter(id => picked.value.includes(id) && allowed.value.has(id))
  if (!ids.length) {
    pickError.value = true
    return
  }
  emit('save', install.value.bot_id, ids)
}

function focus() {
  titleEl.value?.focus()
}

onMounted(() => { if (props.autofocus) focus() })
defineExpose({ focus })
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.matrix-setup {
  padding-top: 4px;
}

.matrix-setup h4:focus {
  outline: none;
}

.matrix-setup h4:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
  border-radius: 4px;
}

.bot-field {
  max-width: 420px;
}

.channel-pick {
  margin: 0 0 12px;
  padding: 0;
  border: none;
  min-width: 0;
}

.channel-pick legend {
  padding: 0;
  margin-bottom: 6px;
}

.channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
  background: var(--background-primary);
}

.channel-list li + li {
  border-top: 1px solid var(--background-quaternary);
}

.channel-option {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  padding: 10px 12px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
}

.channel-option input {
  flex-shrink: 0;
  align-self: center;
}

.channel-option.blocked {
  cursor: default;
  color: var(--text-secondary);
}

.channel-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.channel-category,
.channel-note {
  font-size: 12px;
  color: var(--text-secondary);
}

.channel-note {
  font-style: italic;
}
</style>
