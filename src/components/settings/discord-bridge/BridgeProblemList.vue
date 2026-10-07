<template>
  <ul v-if="views.length" class="problem-list" data-testid="bridge-problems" :aria-label="t('discordBridge.problems.listLabel')">
    <li
      v-for="problem in views"
      :key="problem.key"
      :class="['problem', `problem--${problem.severity}`]"
      :data-code="problem.code"
    >
      <div class="problem-head">
        <Icon :name="problem.severity === 'warn' ? 'alert-triangle' : 'alert-circle'" :size="16" aria-hidden="true" />
        <strong class="problem-title">{{ problem.title }}</strong>
      </div>
      <p class="problem-fix">{{ problem.fix }}</p>
      <BridgeCopyBlock
        v-for="command in problem.commands"
        :key="command"
        :text="command"
        :label="t('discordBridge.common.commandLabel')"
      />
      <div v-if="problem.actions.length" class="db-actions">
        <template v-for="action in problem.actions" :key="action">
          <a
            v-if="action === 'invite'"
            :href="inviteUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-primary btn-sm"
            data-testid="problem-invite"
          >
            <Icon name="external-link" :size="14" aria-hidden="true" />
            {{ t('discordBridge.actions.invite') }}
          </a>
          <a
            v-else-if="action === 'portal'"
            :href="portalUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-secondary btn-sm"
          >
            <Icon name="external-link" :size="14" aria-hidden="true" />
            {{ t('discordBridge.actions.openPortal') }}
          </a>
          <button
            v-else-if="action === 'turnOff' && problem.settingKey"
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="busy"
            :data-testid="`turn-off-${problem.settingKey}`"
            @click="turnOff(problem.settingKey)"
          >
            {{ t('discordBridge.actions.turnOff', { setting: t(`discordBridge.settings.${problem.settingKey}.label`) }) }}
          </button>
          <button
            v-else-if="action === 'connect' || action === 'guild' || action === 'channels'"
            type="button"
            class="btn btn-secondary btn-sm"
            :data-testid="`problem-go-${action}`"
            @click="emit('go', action)"
          >
            {{ t(`discordBridge.actions.go.${action}.${mode}`) }}
          </button>
        </template>
      </div>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import {
  BRIDGE_LOGS_COMMAND,
  BRIDGE_REMOVE_COMMAND,
  BRIDGE_RESET_COMMAND,
  BRIDGE_RESTART_COMMAND,
  BRIDGE_START_COMMAND,
  DISCORD_DEVELOPER_PORTAL_URL,
  buildDiscordInviteUrl,
  normalizeBridgeSettings,
  parseSnapshotGuilds,
  type BridgeProblem,
  type BridgeSettingKey,
  type DiscordBridgeRow,
  type HarmonyChannelOption,
  type SetupStep,
} from '@/utils/discordBridgeSetup'
import { DISCORD_INTENT_NAMES } from './portalLabels'
import { updateSettings } from './bridgeApi'
import { bridgeErrorKey } from './bridgeErrors'
import BridgeCopyBlock from './BridgeCopyBlock.vue'

type Action = 'invite' | 'portal' | 'turnOff' | Extract<SetupStep, 'connect' | 'guild' | 'channels'>

interface ProblemView {
  key: string
  code: string
  severity: 'error' | 'warn'
  title: string
  fix: string
  commands: string[]
  actions: Action[]
  settingKey?: BridgeSettingKey
}

const props = defineProps<{
  bridge: DiscordBridgeRow
  problems: BridgeProblem[]
  harmonyChannels: HarmonyChannelOption[]
  harmonyUrl: string
  /** The checklist row carries its own invite button. */
  hideInvite?: boolean
}>()

const emit = defineEmits<{
  go: [step: 'connect' | 'guild' | 'channels']
  changed: []
}>()

const { t } = useI18n()
const toast = useToast()
const busy = ref(false)
const portalUrl = DISCORD_DEVELOPER_PORTAL_URL

const mode = computed(() => props.bridge.mode)
const settings = computed(() => normalizeBridgeSettings(props.bridge.settings))
const guilds = computed(() => parseSnapshotGuilds(props.bridge.snapshot))
const inviteUrl = computed(() => buildDiscordInviteUrl(props.bridge.discord_application_id))

const SETTING_FOR_INTENT: Record<string, BridgeSettingKey> = {
  members: 'sync_member_list',
  presence: 'sync_presence',
}

const WARN_CODES = new Set(['cannot_manage_webhooks', 'rate_limited'])

const KNOWN = new Set([
  'bridge_offline',
  'discord_token_invalid',
  'intent_missing',
  'bot_not_in_guild',
  'no_guild',
  'guild_not_selected',
  'channel_not_visible',
  'cannot_send',
  'cannot_manage_webhooks',
  'harmony_auth_failed',
  'harmony_channel_missing',
  'harmony_channel_encrypted',
  'rate_limited',
  'discord_unreachable',
  'harmony_unreachable',
])

/** Codes whose fix differs between a bridge you run and one the instance runs. */
const MODE_SPECIFIC = new Set([
  'bridge_offline',
  'discord_token_invalid',
  'intent_missing',
  'harmony_auth_failed',
  'discord_unreachable',
  'harmony_unreachable',
  'unknown',
])

function discordChannelLabel(id: string | undefined): string {
  if (!id) return t('discordBridge.problems.aChannel')
  for (const guild of guilds.value) {
    const channel = guild.channels.find((c) => c.id === id)
    if (channel) return `#${channel.name}`
  }
  return `#${id}`
}

function harmonyChannelLabel(id: string | undefined): string {
  if (!id) return t('discordBridge.problems.aChannel')
  const channel = props.harmonyChannels.find((c) => c.id === id)
  return channel ? `#${channel.name}` : t('discordBridge.problems.aChannel')
}

function guildLabel(id: string | undefined): string {
  const guild = guilds.value.find((g) => g.id === id)
  return guild?.name ?? props.bridge.discord_guild_name ?? t('discordBridge.problems.yourServer')
}

function view(problem: BridgeProblem, index: number): ProblemView {
  const known = KNOWN.has(problem.code)
  const code = known ? problem.code : 'unknown'
  const self = mode.value === 'self'
  const intent = problem.params.intent ?? ''
  const named = {
    intent: DISCORD_INTENT_NAMES[intent as keyof typeof DISCORD_INTENT_NAMES] ?? intent,
    channel: problem.params.discord_channel_id
      ? discordChannelLabel(problem.params.discord_channel_id)
      : harmonyChannelLabel(problem.params.harmony_channel_id),
    guild: guildLabel(problem.params.guild_id),
    url: props.harmonyUrl,
    code: problem.code,
  }
  const base = `discordBridge.problems.${code}`
  const fixKey = MODE_SPECIFIC.has(code) ? `${base}.${self ? 'fixSelf' : 'fixHosted'}` : `${base}.fix`

  const commands: string[] = []
  const actions: Action[] = []
  let settingKey: BridgeSettingKey | undefined
  switch (code) {
    case 'bridge_offline':
      if (self) commands.push(BRIDGE_START_COMMAND, BRIDGE_LOGS_COMMAND)
      break
    case 'discord_token_invalid':
      if (self) commands.push(BRIDGE_REMOVE_COMMAND)
      actions.push('portal', 'connect')
      break
    case 'intent_missing':
      if (self) commands.push(BRIDGE_RESTART_COMMAND)
      actions.push('portal')
      settingKey = SETTING_FOR_INTENT[intent]
      if (settingKey && settings.value[settingKey]) actions.push('turnOff')
      break
    case 'bot_not_in_guild':
      actions.push('invite', 'guild')
      break
    case 'no_guild':
      actions.push('invite')
      break
    case 'guild_not_selected':
      actions.push('guild')
      break
    case 'harmony_auth_failed':
      if (self) {
        commands.push(BRIDGE_RESET_COMMAND)
        actions.push('connect')
      }
      break
    case 'harmony_channel_missing':
    case 'harmony_channel_encrypted':
      actions.push('channels')
      break
    case 'unknown':
      if (self) commands.push(BRIDGE_LOGS_COMMAND)
      break
  }

  const shownActions = actions.filter((a) => a !== 'invite' || (inviteUrl.value && !props.hideInvite))

  return {
    key: `${index}:${problem.code}:${JSON.stringify(problem.params)}`,
    code: problem.code,
    severity: WARN_CODES.has(code) ? 'warn' : 'error',
    title: t(`${base}.title`, named),
    fix: t(fixKey, named),
    commands,
    actions: shownActions,
    settingKey,
  }
}

const views = computed(() => props.problems.map(view))

async function turnOff(key: BridgeSettingKey) {
  busy.value = true
  try {
    await updateSettings(props.bridge.id, { ...settings.value, [key]: false })
    emit('changed')
  } catch (error) {
    debug.error('discord_bridge_update_settings failed:', error)
    toast.error(t(bridgeErrorKey(error, 'discordBridge.errors.settings')))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.problem-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.problem {
  padding: 12px 14px;
  border-radius: 6px;
  border-left: 3px solid var(--error);
  background: color-mix(in srgb, var(--error) 9%, transparent);
  min-width: 0;
}

.problem--warn {
  border-left-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
}

.problem-head {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--error);
}

.problem--warn .problem-head {
  color: var(--text-primary);
}

.problem-head :deep(.icon-wrap) {
  margin-top: 2px;
  flex-shrink: 0;
}

.problem-title {
  font-size: 14px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.problem-fix {
  margin: 6px 0 10px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.problem .db-code-block:last-child,
.problem .db-actions:last-child {
  margin-bottom: 0;
}
</style>
