<template>
  <div class="stepper" data-testid="bridge-stepper">
    <nav class="db-card step-nav" :aria-label="t('discordBridge.steps.navLabel')">
      <ol :style="{ '--step-count': steps.length, '--step-columns': Math.min(steps.length, 3) }">
        <li v-for="(step, index) in steps" :key="step">
          <button
            type="button"
            :class="['step-link', `step-link--${stepState(step)}`, { current: current === step }]"
            :aria-current="current === step ? 'step' : undefined"
            :aria-label="t('discordBridge.steps.navItem', { n: index + 1, name: stepName(step) })"
            :disabled="!available(step)"
            :data-testid="`nav-${step}`"
            @click="emit('go', step)"
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
      <p class="step-count">{{ t('discordBridge.steps.count', { n: currentIndex + 1, total: steps.length }) }}</p>
      <h3 :id="headingId" ref="heading" class="db-card-title" tabindex="-1">
        {{ stepName(current) }}
      </h3>

      <slot />

      <p v-if="hint" class="db-muted next-hint" data-testid="next-hint">{{ hint }}</p>

      <div class="db-actions step-footer">
        <button v-if="currentIndex > 0" type="button" class="btn btn-secondary" data-testid="step-back" @click="emit('back')">
          {{ t('discordBridge.steps.back') }}
        </button>
        <button
          v-if="current !== lastStep"
          type="button"
          class="btn btn-primary"
          :disabled="!canAdvance"
          data-testid="step-next"
          @click="emit('next')"
        >
          {{ nextLabel }}
        </button>
        <button v-else type="button" class="btn btn-primary" :disabled="!canFinish" data-testid="step-finish" @click="emit('finish')">
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

<script setup lang="ts" generic="Step extends string">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'

const props = withDefaults(
  defineProps<{
    steps: readonly Step[]
    current: Step
    /** The first step that still needs the admin; those before it are done. */
    derived: Step
    stepName: (step: Step) => string
    available?: (step: Step) => boolean
    canAdvance: boolean
    canFinish: boolean
    nextLabel: string
    /** Why Next is disabled. */
    hint?: string
  }>(),
  { available: () => true, hint: '' },
)

const emit = defineEmits<{
  go: [step: Step]
  back: []
  next: []
  finish: []
  'start-over': []
}>()

const { t } = useI18n()
const headingId = `bridge-step-${useId()}`
const heading = ref<HTMLElement | null>(null)

const currentIndex = computed(() => props.steps.indexOf(props.current))
const derivedIndex = computed(() => props.steps.indexOf(props.derived))
const lastStep = computed(() => props.steps[props.steps.length - 1])

function stepState(step: Step): 'done' | 'todo' {
  return props.steps.indexOf(step) < derivedIndex.value ? 'done' : 'todo'
}

defineExpose({ focusHeading: () => heading.value?.focus() })
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
  grid-template-columns: repeat(var(--step-columns), minmax(0, 1fr));
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
  color: var(--text-link);
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

@media (max-width: 520px) {
  .step-nav ol {
    grid-template-columns: repeat(var(--step-count), minmax(0, 1fr));
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
