<template>
  <BridgeStepShell
    ref="shell"
    :steps="steps"
    :current="current"
    :derived="derived"
    :step-name="stepName"
    :available="available"
    :can-advance="canAdvance"
    :can-finish="pairs.length > 0"
    :next-label="nextLabel"
    :hint="nextBlockedHint"
    @go="(step) => goTo(step, true)"
    @back="back"
    @next="next"
    @finish="emit('finish')"
    @start-over="emit('start-over')"
  >
    <BridgeInstanceLink
      v-if="current === 'link'"
      :server-id="bridge.server_id"
      :guild-name="bridge.discord_guild_id ? bridge.discord_guild_name || bridge.discord_guild_id : null"
    />

    <BridgeDiscordBotStep
      v-else-if="current === 'bot'"
      :bridge-id="bridge.id"
      :mode="bridge.mode"
      :settings="settings"
      :server-name="serverName"
      @changed="emit('changed')"
    />

    <template v-else-if="current === 'connect'">
      <BridgeConnectSelf v-if="bridge.mode === 'self'" :bridge-id="bridge.id" :harmony-url="harmonyUrl" />
      <BridgeConnectHosted v-else :bridge-id="bridge.id" @saved="onTokenSaved" />
    </template>

    <BridgeChecklist
      v-else-if="current === 'check'"
      :bridge="bridge"
      :now="now"
      :harmony-channels="harmonyChannels"
      :harmony-url="harmonyUrl"
      @go="(step) => goTo(step, true)"
      @changed="emit('changed')"
    />

    <BridgeGuildPicker
      v-else-if="current === 'guild'"
      :bridge="bridge"
      :pair-count="pairs.length"
      @changed="emit('changed')"
    />

    <template v-else-if="current === 'channels'">
      <BridgeProblemList
        v-if="bridge.mode === 'instance' && problems.length"
        class="channel-problems"
        :bridge="bridge"
        :problems="problems"
        :harmony-channels="harmonyChannels"
        :harmony-url="harmonyUrl"
        @go="(step) => goTo(step === 'connect' ? 'link' : step, true)"
        @changed="emit('changed')"
      />
      <BridgeChannelPairs
        :bridge="bridge"
        :pairs="pairs"
        :harmony-channels="harmonyChannels"
        :imports="imports"
        :encrypted-channel-ids="encryptedChannelIds"
        :attachment-mode="attachmentMode"
        :import-mode="importMode"
        @changed="emit('changed')"
      />
    </template>

    <template v-else-if="current === 'options'">
      <p class="db-muted">{{ t('discordBridge.steps.options.lead') }}</p>
      <BridgeSettingsPanel :bridge-id="bridge.id" :settings="settings" :mode="bridge.mode" @changed="emit('changed')" />
    </template>
  </BridgeStepShell>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  buildChecklist,
  collectProblems,
  deriveSetupStep,
  normalizeBridgeSettings,
  setupStepsFor,
  type BridgePairRow,
  type DiscordBridgeRow,
  type HarmonyChannelOption,
  type SetupStep,
} from '@/utils/discordBridgeSetup'
import BridgeDiscordBotStep from './BridgeDiscordBotStep.vue'
import BridgeConnectSelf from './BridgeConnectSelf.vue'
import BridgeConnectHosted from './BridgeConnectHosted.vue'
import BridgeChecklist from './BridgeChecklist.vue'
import BridgeGuildPicker from './BridgeGuildPicker.vue'
import BridgeChannelPairs from './BridgeChannelPairs.vue'
import type { ImportJob } from './bridgeApi'
import BridgeSettingsPanel from './BridgeSettingsPanel.vue'
import BridgeInstanceLink from './BridgeInstanceLink.vue'
import BridgeProblemList from './BridgeProblemList.vue'
import BridgeStepShell from './BridgeStepShell.vue'

const props = defineProps<{
  bridge: DiscordBridgeRow
  pairs: BridgePairRow[]
  harmonyChannels: HarmonyChannelOption[]
  imports?: ImportJob[]
  encryptedChannelIds?: string[]
  attachmentMode?: string | null
  importMode?: string | null
  now: number
  harmonyUrl: string
  serverName: string
  /** Opens this step instead of the derived one. */
  initialStep?: SetupStep | null
}>()

const emit = defineEmits<{
  changed: []
  finish: []
  'start-over': []
}>()

const { t } = useI18n()
const shell = ref<{ focusHeading: () => void } | null>(null)

/**
 * How far the admin got before the bridge first reported in. Only the row is
 * authoritative; this per-browser hint keeps a returning admin off step 1 while the
 * bridge has not connected yet.
 */
const reachedKey = computed(() => `harmony.discordBridge.reached.${props.bridge.id}`)
function readReached(): SetupStep | null {
  try {
    const value = localStorage.getItem(reachedKey.value)
    return value === 'connect' || value === 'check' ? value : null
  } catch {
    return null
  }
}
const reached = ref<SetupStep | null>(readReached())
function markReached(step: 'connect' | 'check') {
  if (reached.value === 'check' && step === 'connect') return
  reached.value = step
  try {
    localStorage.setItem(reachedKey.value, step)
  } catch {
    /* storage unavailable: the row still drives the steps */
  }
}

const steps = computed(() => setupStepsFor(props.bridge.mode))
const settings = computed(() => normalizeBridgeSettings(props.bridge.settings))
const problems = computed(() => collectProblems(props.bridge, props.now))
const derived = computed(() => deriveSetupStep(props.bridge, props.pairs.length, props.now, reached.value))
const initial = props.initialStep && steps.value.includes(props.initialStep) ? props.initialStep : null
const current = ref<SetupStep>(initial ?? derived.value)
const currentIndex = computed(() => steps.value.indexOf(current.value))

/**
 * Follow progress while the admin is on the step the row pointed at. The first pair does
 * not leave the pairing step: more pairs usually follow.
 */
watch(derived, (next, previous) => {
  if (current.value !== previous) return
  if (previous === 'channels' && next === 'options') return
  current.value = next
})

function stepName(step: SetupStep): string {
  return t(`discordBridge.steps.${step}.${step === 'connect' ? props.bridge.mode : 'title'}`)
}

const checksPass = computed(() => buildChecklist(props.bridge, props.now).every((item) => item.state === 'ok'))

function available(step: SetupStep): boolean {
  switch (step) {
    case 'guild':
      return !!props.bridge.last_seen_at
    case 'channels':
      return !!props.bridge.discord_guild_id
    default:
      return true
  }
}

const canAdvance = computed(() => {
  switch (current.value) {
    case 'check':
      return checksPass.value
    case 'link':
    case 'guild':
      return !!props.bridge.discord_guild_id
    case 'channels':
      return props.pairs.length > 0
    default:
      return true
  }
})

/** The last step finishes instead and has no Next label. */
const nextLabel = computed(() => {
  if (current.value === 'options') return ''
  return t(`discordBridge.steps.next.${current.value}${current.value === 'connect' ? `.${props.bridge.mode}` : ''}`)
})

const nextBlockedHint = computed(() => {
  if (canAdvance.value) return ''
  if (current.value === 'check') return t('discordBridge.steps.blocked.check')
  if (current.value === 'link') return t('discordBridge.steps.blocked.link')
  if (current.value === 'guild') return t('discordBridge.steps.blocked.guild')
  if (current.value === 'channels') return t('discordBridge.steps.blocked.channels')
  return ''
})

async function goTo(step: SetupStep, focus: boolean) {
  if (!available(step)) return
  current.value = step
  if (focus) {
    await nextTick()
    shell.value?.focusHeading()
  }
}

function next() {
  if (!canAdvance.value) return
  if (current.value === 'bot') markReached('connect')
  if (current.value === 'connect') markReached('check')
  const target = steps.value[currentIndex.value + 1]
  if (target) void goTo(target, true)
}

function back() {
  const target = steps.value[currentIndex.value - 1]
  if (target) void goTo(target, true)
}

function onTokenSaved() {
  markReached('check')
  emit('changed')
  void goTo('check', true)
}
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.channel-problems {
  margin-bottom: 16px;
}
</style>
