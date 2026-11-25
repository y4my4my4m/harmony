<template>
  <BridgeStepShell
    ref="shell"
    :steps="steps"
    :current="current"
    :derived="derived"
    :step-name="stepName"
    :available="available"
    :can-advance="canAdvance"
    :can-finish="bridge.pairs.length > 0"
    :next-label="t(current === 'connect' && bridge.mode === 'self' ? 'discordBridge.steps.next.connect.self' : 'discordBridge.steps.next.check')"
    :hint="hint"
    @go="goTo"
    @back="move(-1)"
    @next="next"
    @finish="emit('finish')"
    @start-over="emit('start-over')"
  >
    <template v-if="current === 'connect'">
      <MatrixConnectSelf v-if="bridge.mode === 'self'" :bridge-id="bridge.id" :harmony-url="harmonyUrl" :connection="bridge.connection" />
      <MatrixConnectHosted v-else :bridge-id="bridge.id" :homeserver-url="bridge.homeserver_url" @saved="onAccount" />
    </template>
    <MatrixChecklist v-else-if="current === 'check'" :bridge="bridge" :now="now" :harmony-url="harmonyUrl" @go="goTo" />
    <MatrixManagedPairs
      v-else
      :bridge="bridge"
      :harmony-channels="harmonyChannels"
      :encrypted-channel-ids="encryptedChannelIds"
      :now="now"
      @state="(state) => emit('state', state)"
    />
  </BridgeStepShell>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HarmonyChannelOption } from '@/utils/discordBridgeSetup'
import {
  buildMatrixChecklist,
  deriveMatrixSetupStep,
  matrixSetupStepsFor,
  type MatrixBridgeState,
  type MatrixSetupStep,
} from '@/utils/matrixBridgeSetup'
import BridgeStepShell from '@/components/settings/discord-bridge/BridgeStepShell.vue'
import MatrixChecklist from './MatrixChecklist.vue'
import MatrixConnectHosted from './MatrixConnectHosted.vue'
import MatrixConnectSelf from './MatrixConnectSelf.vue'
import MatrixManagedPairs from './MatrixManagedPairs.vue'

const props = defineProps<{
  bridge: MatrixBridgeState
  harmonyChannels: HarmonyChannelOption[]
  encryptedChannelIds: string[]
  now: number
  harmonyUrl: string
}>()

const emit = defineEmits<{
  state: [state: MatrixBridgeState]
  finish: []
  'start-over': []
}>()

const { t } = useI18n()
const shell = ref<{ focusHeading: () => void } | null>(null)

/** As BridgeSetupStepper: keeps a returning manager off step 1 while the bridge has not connected yet. */
const reachedKey = `harmony.matrixBridge.reached.${props.bridge.id}`
function readReached(): MatrixSetupStep | null {
  try {
    return localStorage.getItem(reachedKey) === 'check' ? 'check' : null
  } catch {
    return null
  }
}
const reached = ref(readReached())
function markReached() {
  reached.value = 'check'
  try {
    localStorage.setItem(reachedKey, 'check')
  } catch {
    /* storage unavailable: the row still drives the steps */
  }
}

const steps = computed(() => matrixSetupStepsFor(props.bridge.mode))
const derived = computed(() => deriveMatrixSetupStep(props.bridge, props.now, reached.value))
const current = ref<MatrixSetupStep>(derived.value)

/** Follow progress while the manager is on the step the row pointed at; pairing is not left by itself. */
watch(derived, (step, previous) => {
  if (current.value === previous && previous !== 'channels') current.value = step
})

const checksPass = computed(() => buildMatrixChecklist(props.bridge, props.now).every((item) => item.state === 'ok'))

function stepName(step: MatrixSetupStep): string {
  if (step !== 'connect') return t(`discordBridge.steps.${step}.title`)
  return t(props.bridge.mode === 'hosted' ? 'matrixBridge.hosted.step' : 'discordBridge.steps.connect.self')
}

function available(step: MatrixSetupStep): boolean {
  return step !== 'channels' || !!props.bridge.last_seen_at
}

const canAdvance = computed(() => {
  if (current.value === 'connect') return props.bridge.mode === 'self' || props.bridge.has_account
  return current.value !== 'check' || checksPass.value
})

const hint = computed(() => {
  if (!canAdvance.value) return t(current.value === 'connect' ? 'matrixBridge.hosted.blocked' : 'discordBridge.steps.blocked.check')
  return current.value === 'channels' && !props.bridge.pairs.length ? t('discordBridge.steps.blocked.channels') : ''
})

async function goTo(step: MatrixSetupStep) {
  if (!available(step) || !steps.value.includes(step)) return
  current.value = step
  await nextTick()
  shell.value?.focusHeading()
}

function move(delta: number) {
  const step = steps.value[steps.value.indexOf(current.value) + delta]
  if (step) void goTo(step)
}

function next() {
  if (!canAdvance.value) return
  if (current.value === 'connect') markReached()
  move(1)
}

function onAccount(state: MatrixBridgeState) {
  emit('state', state)
  markReached()
  void goTo('check')
}
</script>
