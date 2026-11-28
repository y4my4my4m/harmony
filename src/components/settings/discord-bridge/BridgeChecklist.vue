<template>
  <div data-testid="bridge-checklist">
    <p class="db-muted">{{ t('discordBridge.check.lead') }}</p>

    <BridgeCheckItems
      :items="items"
      :label="(item) => t(`discordBridge.check.items.${item.key}.${item.state}`)"
      :waiting="bridge.last_seen_at ? '' : t(`discordBridge.check.waiting.${bridge.mode}`)"
    >
      <template #default="{ item }">
        <div v-if="item.key === 'invited' && item.state !== 'ok' && inviteUrl" class="db-actions check-action">
          <a :href="inviteUrl" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" data-testid="invite-bot">
            <Icon name="external-link" :size="14" aria-hidden="true" />
            {{ t('discordBridge.actions.invite') }}
          </a>
          <span class="db-muted invite-hint">{{ t('discordBridge.check.inviteHint') }}</span>
        </div>
      </template>
    </BridgeCheckItems>

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
  type DiscordBridgeRow,
  type HarmonyChannelOption,
} from '@/utils/discordBridgeSetup'
import BridgeCheckItems from './BridgeCheckItems.vue'
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

const { t } = useI18n()
const items = computed(() => buildChecklist(props.bridge, props.now))
const problems = computed(() => collectProblems(props.bridge, props.now))
const inviteUrl = computed(() => buildDiscordInviteUrl(props.bridge.discord_application_id))
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.check-action {
  align-items: center;
}

.invite-hint {
  margin: 0;
}

.not-connecting {
  margin-top: 14px;
}
</style>
