<template>
  <section class="bridge-admin" data-testid="bridge-admin-section" :aria-labelledby="titleId">
    <h3 :id="titleId">{{ t('discordBridge.adminSection.title') }}</h3>
    <p class="hint">{{ t('discordBridge.adminSection.lead') }}</p>
    <BridgeServiceStatus platform="discord" />
    <BridgeInstanceBotAdmin />
    <BridgeHostingAdmin />
    <BridgeImportAdmin />
  </section>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import BridgeHostingAdmin from './BridgeHostingAdmin.vue'
import BridgeImportAdmin from './BridgeImportAdmin.vue'
import BridgeInstanceBotAdmin from './BridgeInstanceBotAdmin.vue'
import BridgeServiceStatus from './BridgeServiceStatus.vue'

const { t } = useI18n()
const titleId = `bridge-admin-${useId()}`
</script>

<style scoped src="./bridgeAdmin.css"></style>
