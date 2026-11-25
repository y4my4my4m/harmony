<template>
  <p class="db-muted">{{ t('discordBridge.self.troubleLogs') }}</p>
  <BridgeCopyBlock :text="logs" :label="t('discordBridge.common.commandLabel')" />
  <p class="db-muted">{{ t('discordBridge.self.troubleNameInUse') }}</p>
  <BridgeCopyBlock :text="remove" :label="t('discordBridge.common.commandLabel')" />
  <template v-if="reset">
    <p class="db-muted">{{ t('discordBridge.self.troubleReset') }}</p>
    <BridgeCopyBlock :text="reset" :label="t('discordBridge.common.commandLabel')" />
  </template>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import BridgeCopyBlock from './BridgeCopyBlock.vue'

defineProps<{
  logs: string
  remove: string
  /** Removes the container and its data. */
  reset?: string
}>()

const { t } = useI18n()
</script>

<style scoped src="./bridge.css"></style>
