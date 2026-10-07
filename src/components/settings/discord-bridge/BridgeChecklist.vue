<template>
  <div data-testid="bridge-checklist">
    <p class="db-muted">{{ t('discordBridge.check.lead') }}</p>

    <div v-if="!bridge.last_seen_at" class="db-banner" role="status" data-testid="check-waiting">
      <p class="waiting">
        <Icon name="spinner" :size="16" class="spin" aria-hidden="true" />
        <span>{{ t(`discordBridge.check.waiting.${bridge.mode}`) }}</span>
      </p>
    </div>

    <ul class="check-list" aria-live="polite">
      <li v-for="item in items" :key="item.key" :class="['check', `check--${item.state}`]" :data-check="item.key" :data-state="item.state">
        <Icon :name="ICON[item.state]" :size="18" :class="item.state === 'waiting' ? 'spin-slow' : ''" aria-hidden="true" />
        <div class="check-body">
          <span class="check-label">{{ t(`discordBridge.check.items.${item.key}.${item.state}`) }}</span>
          <span class="db-sr-only">{{ t(`discordBridge.check.state.${item.state}`) }}</span>
          <div v-if="item.key === 'invited' && item.state !== 'ok' && inviteUrl" class="db-actions check-action">
            <a :href="inviteUrl" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" data-testid="invite-bot">
              <Icon name="external-link" :size="14" aria-hidden="true" />
              {{ t('discordBridge.actions.invite') }}
            </a>
            <span class="db-muted invite-hint">{{ t('discordBridge.check.inviteHint') }}</span>
          </div>
        </div>
      </li>
    </ul>

    <BridgeProblemList
      :bridge="bridge"
      :problems="problems"
      :harmony-channels="harmonyChannels"
      :harmony-url="harmonyUrl"
      hide-invite
      @go="(step) => emit('go', step)"
      @changed="emit('changed')"
    />

    <details v-if="!bridge.last_seen_at" class="db-details not-connecting">
      <summary>{{ t('discordBridge.check.notConnecting.title') }}</summary>
      <template v-if="bridge.mode === 'self'">
        <ul class="db-steps">
          <li>{{ t('discordBridge.check.notConnecting.self.docker') }}</li>
          <li>{{ t('discordBridge.check.notConnecting.self.logs') }}</li>
        </ul>
        <BridgeCopyBlock :text="BRIDGE_LOGS_COMMAND" :label="t('discordBridge.common.commandLabel')" />
        <ul class="db-steps">
          <li>{{ t('discordBridge.check.notConnecting.self.code') }}</li>
        </ul>
        <div class="db-actions">
          <button type="button" class="btn btn-secondary btn-sm" @click="emit('go', 'connect')">
            {{ t('discordBridge.actions.go.connect.self') }}
          </button>
        </div>
      </template>
      <template v-else>
        <ul class="db-steps">
          <li>{{ t('discordBridge.check.notConnecting.hosted.token') }}</li>
          <li>{{ t('discordBridge.check.notConnecting.hosted.host') }}</li>
        </ul>
        <div class="db-actions">
          <button type="button" class="btn btn-secondary btn-sm" @click="emit('go', 'connect')">
            {{ t('discordBridge.actions.go.connect.hosted') }}
          </button>
        </div>
      </template>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import {
  BRIDGE_LOGS_COMMAND,
  buildChecklist,
  buildDiscordInviteUrl,
  collectProblems,
  type CheckState,
  type DiscordBridgeRow,
  type HarmonyChannelOption,
} from '@/utils/discordBridgeSetup'
import BridgeProblemList from './BridgeProblemList.vue'
import BridgeCopyBlock from './BridgeCopyBlock.vue'

const props = defineProps<{
  bridge: DiscordBridgeRow
  now: number
  harmonyChannels: HarmonyChannelOption[]
  harmonyUrl: string
}>()

const emit = defineEmits<{
  go: [step: 'connect' | 'guild' | 'channels']
  changed: []
}>()

const ICON: Record<CheckState, string> = { ok: 'check-circle', fail: 'x-circle', waiting: 'spinner' }

const { t } = useI18n()
const items = computed(() => buildChecklist(props.bridge, props.now))
const problems = computed(() => collectProblems(props.bridge, props.now))
const inviteUrl = computed(() => buildDiscordInviteUrl(props.bridge.discord_application_id))
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.waiting {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.waiting :deep(.icon-wrap) {
  margin-top: 2px;
  flex-shrink: 0;
}

.check-list {
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.check {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 4px;
  border-bottom: 1px solid var(--background-quaternary);
}

.check:last-child {
  border-bottom: none;
}

.check :deep(.icon-wrap) {
  margin-top: 1px;
  flex-shrink: 0;
}

.check--ok {
  color: var(--success);
}

.check--fail {
  color: var(--error);
}

.check--waiting {
  color: var(--text-secondary);
}

.check-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.check-label {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.45;
}

.check-action {
  align-items: center;
}

.invite-hint {
  margin: 0;
}

.not-connecting {
  margin-top: 14px;
}

.spin :deep(svg),
.spin-slow :deep(svg) {
  animation: bridge-spin 1.2s linear infinite;
}

.spin-slow :deep(svg) {
  animation-duration: 2.4s;
}

@keyframes bridge-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin :deep(svg),
  .spin-slow :deep(svg) {
    animation: none;
  }
}
</style>
