<template>
  <div data-testid="bridge-checklist">
    <p class="db-muted">{{ t('discordBridge.check.lead') }}</p>

    <BridgeCheckItems
      :items="items"
      :label="(item) => t(item.key === 'matrix' ? `matrixBridge.check.matrix.${item.state}` : `discordBridge.check.items.${item.key}.${item.state}`)"
      :waiting="bridge.last_seen_at ? '' : t(self ? 'matrixBridge.check.waiting' : 'discordBridge.check.waiting.hosted')"
    />

    <MatrixProblemList :bridge="bridge" :problems="problems" :harmony-url="harmonyUrl" @go="(step) => emit('go', step)" />

    <details v-if="!bridge.last_seen_at" class="db-details not-connecting">
      <summary>{{ t('discordBridge.check.notConnecting.title') }}</summary>
      <template v-if="self">
        <ul class="db-steps">
          <li>{{ t('matrixBridge.check.running') }}</li>
          <li>{{ t('discordBridge.check.notConnecting.self.logs') }}</li>
        </ul>
        <BridgeCopyBlock :text="MATRIX_LOGS_COMMAND" :label="t('discordBridge.common.commandLabel')" />
        <ul class="db-steps">
          <li>{{ t('matrixBridge.check.code') }}</li>
        </ul>
        <div class="db-actions">
          <button type="button" class="btn btn-secondary btn-sm" @click="emit('go', 'connect')">
            {{ t('discordBridge.actions.go.connect.self') }}
          </button>
        </div>
      </template>
      <ul v-else class="db-steps" data-testid="matrix-host-help">
        <li v-if="bridge.mode === 'hosted'">{{ t('matrixBridge.check.account') }}</li>
        <li>{{ t('discordBridge.check.notConnecting.hosted.host') }}</li>
      </ul>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MATRIX_LOGS_COMMAND, buildMatrixChecklist, collectMatrixProblems, type MatrixBridgeState } from '@/utils/matrixBridgeSetup'
import BridgeCheckItems from '@/components/settings/discord-bridge/BridgeCheckItems.vue'
import BridgeCopyBlock from '@/components/settings/discord-bridge/BridgeCopyBlock.vue'
import MatrixProblemList from './MatrixProblemList.vue'

const props = defineProps<{
  bridge: MatrixBridgeState
  now: number
  harmonyUrl: string
}>()

const emit = defineEmits<{ go: [step: 'connect' | 'channels'] }>()

const { t } = useI18n()
const self = computed(() => props.bridge.mode === 'self')
const items = computed(() => buildMatrixChecklist(props.bridge, props.now))
const problems = computed(() => collectMatrixProblems(props.bridge, props.now))
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.not-connecting {
  margin-top: 14px;
}
</style>
