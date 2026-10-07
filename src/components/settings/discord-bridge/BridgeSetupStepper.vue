<template>
  <div class="stepper" data-testid="bridge-stepper">
    <nav class="db-card step-nav" :aria-label="t('discordBridge.steps.navLabel')">
      <ol>
        <li v-for="(step, index) in SETUP_STEPS" :key="step">
          <button
            type="button"
            :class="['step-link', `step-link--${stepState(step)}`, { current: current === step }]"
            :aria-current="current === step ? 'step' : undefined"
            :aria-label="t('discordBridge.steps.navItem', { n: index + 1, name: stepName(step) })"
            :disabled="!available(step)"
            :data-testid="`nav-${step}`"
            @click="goTo(step, true)"
          >
            <span class="step-index" aria-hidden="true">
              <Icon v-if="stepState(step) === 'done'" name="check" :size="14" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            <span class="step-name">{{ stepName(step) }}</span>
            <span v-if="stepState(step) === 'done'" class="db-sr-only">{{ t('discordBridge.steps.doneSr') }}</span>
          </button>
        </li>
      </ol>
    </nav>

    <section class="db-card step-panel" :aria-labelledby="headingId" :data-step="current">
      <p class="step-count">{{ t('discordBridge.steps.count', { n: currentIndex + 1, total: SETUP_STEPS.length }) }}</p>
      <h3 :id="headingId" ref="heading" class="db-card-title" tabindex="-1">
        {{ stepName(current) }}
      </h3>

      <BridgeDiscordBotStep
        v-if="current === 'bot'"
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

      <BridgeChannelPairs
        v-else-if="current === 'channels'"
        :bridge="bridge"
        :pairs="pairs"
        :harmony-channels="harmonyChannels"
        @changed="emit('changed')"
      />

      <template v-else-if="current === 'options'">
        <p class="db-muted">{{ t('discordBridge.steps.options.lead') }}</p>
        <BridgeSettingsPanel :bridge-id="bridge.id" :settings="settings" @changed="emit('changed')" />
      </template>

      <p v-if="nextBlockedHint" class="db-muted next-hint" data-testid="next-hint">{{ nextBlockedHint }}</p>

      <div class="db-actions step-footer">
        <button v-if="currentIndex > 0" type="button" class="btn btn-secondary" data-testid="step-back" @click="back">
          {{ t('discordBridge.steps.back') }}
        </button>
        <button
          v-if="current !== 'options'"
          type="button"
          class="btn btn-primary"
          :disabled="!canAdvance"
          data-testid="step-next"
          @click="next"
        >
          {{ t(`discordBridge.steps.next.${current}${current === 'connect' ? `.${bridge.mode}` : ''}`) }}
        </button>
        <button v-else type="button" class="btn btn-primary" :disabled="pairs.length === 0" data-testid="step-finish" @click="emit('finish')">
          {{ t('discordBridge.steps.finish') }}
        </button>
      </div>
    </section>

    <p class="db-muted start-over">
      {{ t('discordBridge.steps.startOver.prompt') }}
      <button type="button" class="link-button" data-testid="start-over" @click="emit('start-over')">
        {{ t('discordBridge.steps.startOver.action') }}
      </button>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import {
  SETUP_STEPS,
  buildChecklist,
  deriveSetupStep,
  normalizeBridgeSettings,
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
import BridgeSettingsPanel from './BridgeSettingsPanel.vue'

const props = defineProps<{
  bridge: DiscordBridgeRow
  pairs: BridgePairRow[]
  harmonyChannels: HarmonyChannelOption[]
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
const headingId = `bridge-step-${useId()}`
const heading = ref<HTMLElement | null>(null)

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

const settings = computed(() => normalizeBridgeSettings(props.bridge.settings))
const derived = computed(() => deriveSetupStep(props.bridge, props.pairs.length, props.now, reached.value))
const derivedIndex = computed(() => SETUP_STEPS.indexOf(derived.value))
const current = ref<SetupStep>(props.initialStep ?? derived.value)
const currentIndex = computed(() => SETUP_STEPS.indexOf(current.value))

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

function stepState(step: SetupStep): 'done' | 'todo' {
  return SETUP_STEPS.indexOf(step) < derivedIndex.value ? 'done' : 'todo'
}

const canAdvance = computed(() => {
  switch (current.value) {
    case 'check':
      return checksPass.value
    case 'guild':
      return !!props.bridge.discord_guild_id
    case 'channels':
      return props.pairs.length > 0
    default:
      return true
  }
})

const nextBlockedHint = computed(() => {
  if (canAdvance.value) return ''
  if (current.value === 'check') return t('discordBridge.steps.blocked.check')
  if (current.value === 'guild') return t('discordBridge.steps.blocked.guild')
  if (current.value === 'channels') return t('discordBridge.steps.blocked.channels')
  return ''
})

async function goTo(step: SetupStep, focus: boolean) {
  if (!available(step)) return
  current.value = step
  if (focus) {
    await nextTick()
    heading.value?.focus()
  }
}

function next() {
  if (!canAdvance.value) return
  if (current.value === 'bot') markReached('connect')
  if (current.value === 'connect') markReached('check')
  const target = SETUP_STEPS[currentIndex.value + 1]
  if (target) void goTo(target, true)
}

function back() {
  const target = SETUP_STEPS[currentIndex.value - 1]
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
.step-nav {
  padding: 8px;
}

.step-nav ol {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.step-link {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.step-link:hover:not(:disabled) {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.step-link:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}

.step-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.step-link.current {
  background: color-mix(in srgb, var(--harmony-primary) 14%, transparent);
  color: var(--text-primary);
}

.step-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 2px solid currentColor;
  font-size: 12px;
}

.step-link--done .step-index {
  border-color: var(--success);
  background: var(--success);
  color: var(--text-on-primary, #fff);
}

.step-link.current .step-index {
  border-color: var(--harmony-primary);
  color: var(--harmony-primary);
}

.step-link--done.current .step-index {
  color: var(--text-on-primary, #fff);
  background: var(--success);
}

.step-name {
  min-width: 0;
  line-height: 1.25;
}

.step-count {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.step-panel h3:focus {
  outline: none;
}

.step-panel h3:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.next-hint {
  margin-top: 16px;
}

.step-footer {
  justify-content: flex-end;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--background-quaternary);
}

.start-over {
  text-align: center;
}

.link-button {
  border: none;
  background: none;
  padding: 0;
  color: var(--harmony-primary);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.link-button:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

@media (max-width: 520px) {
  .step-nav ol {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }

  .step-link {
    justify-content: center;
    padding: 6px 2px;
  }

  .step-name {
    display: none;
  }
}
</style>
