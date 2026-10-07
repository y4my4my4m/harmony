<template>
  <section class="bridge-admin" data-testid="bridge-admin-section" :aria-labelledby="titleId">
    <h3 :id="titleId">{{ t('discordBridge.adminSection.title') }}</h3>
    <p class="hint">{{ t('discordBridge.adminSection.lead') }}</p>
    <BridgeInstanceBotAdmin />
    <BridgeHostingAdmin />
  </section>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import BridgeHostingAdmin from './BridgeHostingAdmin.vue'
import BridgeInstanceBotAdmin from './BridgeInstanceBotAdmin.vue'

const { t } = useI18n()
const titleId = `bridge-admin-${useId()}`
</script>

<style scoped>
.bridge-admin {
  margin-top: 24px;
}

.bridge-admin h3 {
  margin: 0 0 8px;
}

.hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}
</style>
