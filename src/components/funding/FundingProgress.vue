<!--
  FundingProgress - amount raised this period, against the goal when there is one: the bar,
  the share funded, the supporter count and, for a monthly goal, the day it resets in UTC.
-->
<template>
  <section class="support-progress" :aria-label="t('support.progress')" data-testid="support-progress">
    <p class="support-progress__figures">
      <span class="support-progress__raised" data-testid="support-raised">{{ money(raised) }}</span>
      <span class="support-progress__goal">{{ goalText }}</span>
    </p>
    <div
      v-if="goal && showBar"
      class="support-progress__track"
      role="progressbar"
      :aria-valuenow="percent"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="t('support.progress')"
    >
      <div class="support-progress__fill" :style="{ width: percent + '%' }"></div>
    </div>
    <p class="support-progress__stats">
      <span v-if="goal"><strong>{{ percent }}%</strong> {{ t('support.funded') }}</span>
      <span v-if="supporters > 0"><strong>{{ supporters }}</strong> {{ t('support.supporters', supporters) }}</span>
      <span v-if="resetText" class="support-progress__reset" data-testid="support-reset">
        <Icon name="clock" :size="12" aria-hidden="true" />
        {{ resetText }}
      </span>
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { formatMoney, formatUtcDay } from './format'

const props = withDefaults(defineProps<{
  raised: number
  goal?: number | null
  currency: string
  period: 'monthly' | 'all'
  periodEnd?: string | null
  supporters?: number
  showBar?: boolean
}>(), {
  goal: null,
  periodEnd: null,
  supporters: 0,
  showBar: true,
})

const { t, locale } = useT()

const money = (amount: number) => formatMoney(amount, props.currency, locale.value)

const percent = computed(() => {
  if (!props.goal) return 0
  return Math.min(100, Math.round((props.raised / props.goal) * 100))
})

const goalText = computed(() => {
  if (props.goal) {
    return t(props.period === 'all' ? 'support.raisedTotal' : 'support.raisedMonth', { goal: money(props.goal) })
  }
  return t(props.period === 'all' ? 'support.raisedAllTime' : 'support.raisedThisMonth')
})

const resetText = computed(() => {
  if (props.period !== 'monthly' || !props.periodEnd) return ''
  const day = formatUtcDay(props.periodEnd, locale.value)
  return day ? t('support.resets', { date: day }) : ''
})
</script>

<style scoped>
.support-progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.support-progress__figures {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
}

.support-progress__raised {
  font-size: var(--font-size-3xl);
  font-weight: var(--font-weight-bold);
  line-height: 1;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.support-progress__goal {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.support-progress__track {
  height: 10px;
  overflow: hidden;
  background: var(--background-modifier-active);
  border-radius: var(--radius-full);
}

.support-progress__fill {
  height: 100%;
  min-width: 6px;
  background: var(--harmony-primary);
  border-radius: var(--radius-full);
}

@media (prefers-reduced-motion: no-preference) {
  .support-progress__fill {
    transition: width 0.5s ease;
  }
}

.support-progress__stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: var(--space-4);
  row-gap: var(--space-1);
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.support-progress__stats strong {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.support-progress__reset {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: auto;
  font-size: var(--font-size-xs);
}
</style>
