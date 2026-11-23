<template>
  <section class="db-card" :aria-labelledby="`${uid}-title`" data-testid="matrix-status" :data-state="kind">
    <div class="status-head">
      <span :class="['status-dot', kind]" aria-hidden="true"></span>
      <div class="status-text">
        <h3 :id="`${uid}-title`" class="db-card-title" data-testid="matrix-status-title">{{ t(`matrixBridge.status.${kind}`) }}</h3>
        <p class="db-muted" data-testid="matrix-status-line">{{ line }}</p>
      </div>
    </div>
    <template v-if="pairs.length">
      <dl class="facts">
        <div>
          <dt>{{ t('matrixBridge.status.facts.bot', bots.length) }}</dt>
          <dd data-testid="matrix-status-bot">{{ bots.join(', ') }}</dd>
        </div>
        <div>
          <dt>{{ t('matrixBridge.status.facts.paired') }}</dt>
          <dd data-testid="matrix-status-paired">{{ pairs.length }}</dd>
        </div>
        <div>
          <dt>{{ t('matrixBridge.status.facts.rooms') }}</dt>
          <dd data-testid="matrix-status-rooms">{{ counts.connected }}</dd>
        </div>
        <div>
          <dt>{{ t('matrixBridge.status.facts.waiting') }}</dt>
          <dd data-testid="matrix-status-waiting">{{ counts.waiting }}</dd>
        </div>
        <div v-if="counts.stopped">
          <dt>{{ t('matrixBridge.status.facts.stopped') }}</dt>
          <dd data-testid="matrix-status-stopped">{{ counts.stopped }}</dd>
        </div>
      </dl>
      <p class="db-muted unseen">{{ t('matrixBridge.status.unseen') }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MatrixBridgePair } from './matrixBridgeApi'

const props = defineProps<{ pairs: MatrixBridgePair[] }>()
const { t } = useI18n()
const uid = `matrix-status-${useId()}`

const counts = computed(() => {
  let connected = 0
  let waiting = 0
  let stopped = 0
  for (const pair of props.pairs) {
    if (!pair.active) stopped++
    else if (pair.room_id) connected++
    else waiting++
  }
  return { connected, waiting, stopped }
})

const bots = computed(() => {
  const names = new Map<string, string>()
  for (const pair of props.pairs) if (!names.has(pair.bot_id)) names.set(pair.bot_id, pair.bot_display_name)
  return [...names.values()]
})

const kind = computed<'none' | 'problem' | 'waiting' | 'connected'>(() => {
  if (!props.pairs.length) return 'none'
  if (counts.value.stopped) return 'problem'
  return counts.value.waiting ? 'waiting' : 'connected'
})

const line = computed(() => {
  if (kind.value === 'problem') return t('matrixBridge.status.line.problem', { count: counts.value.stopped }, counts.value.stopped)
  if (kind.value === 'waiting') return t('matrixBridge.status.line.waiting', { count: counts.value.waiting }, counts.value.waiting)
  return t(`matrixBridge.status.line.${kind.value}`)
})
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
/* Status head and facts as BridgeStatusView.vue. */
.status-head {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.status-dot {
  width: 12px;
  height: 12px;
  margin-top: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-secondary);
}

.status-dot.connected {
  background: var(--success);
}

.status-dot.problem {
  background: var(--warning);
}

.status-text {
  min-width: 0;
}

.status-text .db-card-title {
  margin-bottom: 2px;
}

.status-text .db-muted {
  margin-bottom: 0;
}

.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
  margin: 16px 0;
}

.facts div {
  min-width: 0;
}

.facts dt {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.facts dd {
  margin: 2px 0 0;
  font-size: 14px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.unseen {
  margin-bottom: 0;
}

@media (max-width: 520px) {
  .facts {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
