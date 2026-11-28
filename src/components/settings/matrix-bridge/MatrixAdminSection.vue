<template>
  <section class="bridge-admin" data-testid="matrix-admin-section" :aria-labelledby="titleId">
    <h3 :id="titleId">{{ t('matrixBridge.admin.title') }}</h3>
    <p class="hint">{{ t('matrixBridge.admin.lead') }}</p>
    <BridgeServiceStatus platform="matrix" />
    <MatrixInstanceAdmin @status="(status) => (hostedCount = status.hostedCount)" />
    <BridgeHostingAdmin platform="matrix" :count="hostedCount" />
  </section>
</template>

<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import BridgeHostingAdmin from '@/components/settings/discord-bridge/BridgeHostingAdmin.vue'
import BridgeServiceStatus from '@/components/settings/discord-bridge/BridgeServiceStatus.vue'
import MatrixInstanceAdmin from './MatrixInstanceAdmin.vue'

const { t } = useI18n()
const titleId = `matrix-admin-${useId()}`
const hostedCount = ref<number | null>(null)
</script>

<style scoped src="../discord-bridge/bridgeAdmin.css"></style>
