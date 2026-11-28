<template>
  <BridgeProblemCards :problems="views">
    <template #actions="{ problem }">
      <button
        v-for="action in problem.actions"
        :key="action"
        type="button"
        class="btn btn-secondary btn-sm"
        :data-testid="`problem-go-${action}`"
        @click="emit('go', action)"
      >
        {{ t(action === 'connect' && bridge.mode === 'hosted' ? 'matrixBridge.hosted.replace' : `discordBridge.actions.go.${action}.self`) }}
      </button>
    </template>
  </BridgeProblemCards>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  MATRIX_LOGS_COMMAND,
  MATRIX_REGISTRATION_COPY,
  MATRIX_REMOVE_COMMAND,
  MATRIX_RESTART_COMMAND,
  MATRIX_START_COMMAND,
  isMatrixNotice,
  matrixRoomLabel,
  type MatrixBridgeProblem,
  type MatrixBridgeState,
} from '@/utils/matrixBridgeSetup'
import BridgeProblemCards, { type BridgeProblemCard } from '@/components/settings/discord-bridge/BridgeProblemCards.vue'

type Action = 'connect' | 'channels'
interface ProblemView extends BridgeProblemCard {
  actions: Action[]
}

const props = defineProps<{
  bridge: MatrixBridgeState
  problems: MatrixBridgeProblem[]
  harmonyUrl: string
}>()

const emit = defineEmits<{ go: [step: Action] }>()

const { t } = useI18n()

/** Problems whose wording is under matrixBridge.problems; the rest show the bridge's own words. */
const KNOWN = new Set([
  'bridge_offline',
  'matrix_registration_missing',
  'matrix_token_invalid',
  'matrix_unreachable',
  'harmony_auth_failed',
  'harmony_unreachable',
  'room_encrypted',
  'room_not_joined',
  'worker_stopped',
  'messages_skipped',
  'account_in_use',
])

/** Strings of the Discord bridge that name no platform. */
const SHARED: Record<string, { title: string; fix?: string }> = {
  bridge_offline: { title: 'discordBridge.problems.bridge_offline.title' },
  harmony_auth_failed: { title: 'discordBridge.problems.harmony_auth_failed.title' },
  harmony_unreachable: {
    title: 'discordBridge.problems.harmony_unreachable.title',
    fix: 'discordBridge.problems.harmony_unreachable.fixSelf',
  },
  unknown: { title: 'discordBridge.problems.unknown.title', fix: 'discordBridge.problems.unknown.fixSelf' },
}

/** Fixes of a bridge the instance runs, which its manager has no computer to turn to for. */
const RUN_BY_INSTANCE: Record<string, string> = {
  bridge_offline: 'discordBridge.problems.bridge_offline.fixHosted',
  harmony_auth_failed: 'discordBridge.problems.harmony_auth_failed.fixHosted',
  harmony_unreachable: 'discordBridge.problems.harmony_unreachable.fixHosted',
  worker_stopped: 'discordBridge.problems.unknown.fixHosted',
  unknown: 'discordBridge.problems.unknown.fixHosted',
}

/** What the instance's admin settles, not the community. */
const INSTANCE_SIDE = new Set(['matrix_registration_missing', 'matrix_token_invalid', 'matrix_unreachable', 'account_in_use'])

const COMMANDS: Record<string, string[]> = {
  bridge_offline: [MATRIX_START_COMMAND, MATRIX_LOGS_COMMAND],
  matrix_registration_missing: [MATRIX_REGISTRATION_COPY],
  harmony_auth_failed: [MATRIX_REMOVE_COMMAND],
  worker_stopped: [MATRIX_RESTART_COMMAND],
  unknown: [MATRIX_LOGS_COMMAND],
}

const ACTIONS: Record<string, Action[]> = {
  matrix_registration_missing: ['connect'],
  matrix_token_invalid: ['connect'],
  account_in_use: ['connect'],
  harmony_auth_failed: ['connect'],
  room_encrypted: ['channels'],
  room_not_joined: ['channels'],
}

const mode = computed(() => props.bridge.mode)

function fixKey(code: string): string {
  if (mode.value === 'instance' && INSTANCE_SIDE.has(code)) return 'discordBridge.problems.harmony_unreachable.fixInstance'
  if (mode.value !== 'self' && RUN_BY_INSTANCE[code]) return RUN_BY_INSTANCE[code]
  if (code === 'matrix_token_invalid') {
    if (mode.value === 'hosted') return 'matrixBridge.problems.matrix_token_invalid.fixHosted'
    return `matrixBridge.problems.${code}.${props.bridge.connection === 'account' ? 'fixAccount' : 'fixAppService'}`
  }
  if (code === 'matrix_unreachable' && mode.value === 'hosted') return 'matrixBridge.problems.matrix_unreachable.fixHosted'
  return SHARED[code]?.fix ?? `matrixBridge.problems.${code}.fix`
}

/** The connect step of a hosted bridge is its account; an instance's bridge has none. */
function actionsFor(code: string): Action[] {
  const actions = ACTIONS[code] ?? []
  if (mode.value === 'self') return actions
  return actions.filter((action) => action !== 'connect' || (mode.value === 'hosted' && code !== 'harmony_auth_failed'))
}

function view(problem: MatrixBridgeProblem, index: number): ProblemView {
  const code = KNOWN.has(problem.code) ? problem.code : 'unknown'
  const aboutRoom = /^[!#]/.test(problem.detail)
  const named = {
    code: problem.code,
    room: aboutRoom ? matrixRoomLabel(props.bridge.rooms, problem.detail) : t('matrixBridge.problems.aRoom'),
    homeserver: props.bridge.status.homeserver ?? props.bridge.homeserver_url ?? t('matrixBridge.problems.theHomeserver'),
    url: props.harmonyUrl,
  }
  return {
    key: `${index}:${problem.code}`,
    code: problem.code,
    severity: isMatrixNotice(problem) ? 'info' : 'error',
    title: t(SHARED[code]?.title ?? `matrixBridge.problems.${code}.title`, named),
    fix: t(fixKey(code), named),
    detail: aboutRoom ? '' : problem.detail,
    commands: mode.value === 'self' ? (COMMANDS[code] ?? []) : [],
    actions: actionsFor(code),
  }
}

const views = computed(() => props.problems.map(view))
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
