<template>
  <ul v-if="problems.length" class="problem-list" data-testid="bridge-problems" :aria-label="t('discordBridge.problems.listLabel')">
    <li
      v-for="problem in problems"
      :key="problem.key"
      :class="['problem', `problem--${problem.severity}`]"
      :data-code="problem.code"
    >
      <div class="problem-head">
        <Icon :name="SEVERITY_ICON[problem.severity]" :size="16" aria-hidden="true" />
        <strong class="problem-title">{{ problem.title }}</strong>
      </div>
      <p class="problem-fix">{{ problem.fix }}</p>
      <p v-if="problem.detail" class="db-muted problem-detail">{{ problem.detail }}</p>
      <BridgeCopyBlock
        v-for="command in problem.commands"
        :key="command"
        :text="command"
        :label="t('discordBridge.common.commandLabel')"
      />
      <div v-if="problem.actions.length" class="db-actions">
        <slot name="actions" :problem="problem" />
      </div>
    </li>
  </ul>
</template>

<script lang="ts">
export interface BridgeProblemCard {
  key: string
  code: string
  severity: 'error' | 'warn' | 'info'
  title: string
  fix: string
  /** The bridge's own words. */
  detail?: string
  commands: string[]
  actions: readonly string[]
}
</script>

<script setup lang="ts" generic="Problem extends BridgeProblemCard">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import BridgeCopyBlock from './BridgeCopyBlock.vue'

const SEVERITY_ICON: Record<BridgeProblemCard['severity'], string> = { error: 'alert-circle', warn: 'alert-triangle', info: 'info' }

defineProps<{ problems: readonly Problem[] }>()

const { t } = useI18n()
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

.problem--info {
  border-left-color: var(--info);
  background: color-mix(in srgb, var(--info) 10%, transparent);
}

.problem-head {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--text-danger);
}

.problem--warn .problem-head,
.problem--info .problem-head {
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

.problem-detail {
  overflow-wrap: anywhere;
}

.problem .db-code-block:last-child,
.problem .db-actions:last-child {
  margin-bottom: 0;
}
</style>
