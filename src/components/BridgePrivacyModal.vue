<template>
  <UnifiedModal :model-value="!!store.serverId" :title="t('bridgePrivacy.title')" :subtitle="serverName" size="sm"
    @update:model-value="(open: boolean) => { if (!open) store.close() }">
    <p id="bridge-privacy-description">{{ t('bridgePrivacy.description') }}</p>
    <p id="bridge-privacy-scope" class="privacy-hint">{{ t('bridgePrivacy.scope') }}</p>
    <div v-if="store.loading" role="status" :aria-label="t('bridgePrivacy.loading')"><LoadingSpinner /></div>
    <div v-else-if="store.optOut !== null" class="privacy-row">
      <span id="bridge-privacy-label">{{ t('bridgePrivacy.optOut') }}</span>
      <ToggleSwitch :model-value="store.optOut" :disabled="store.saving || !!store.error" labelledby="bridge-privacy-label"
        describedby="bridge-privacy-description bridge-privacy-scope" @update:model-value="store.setOptOut" />
    </div>
    <p v-if="store.saving" role="status">{{ t('bridgePrivacy.saving') }}</p>
    <p v-if="store.error" role="alert">{{ t(`bridgePrivacy.${store.error}`) }}</p>
    <button v-if="store.error" type="button" class="btn btn-secondary" @click="store.open(store.serverId!)">
      {{ t('bridgePrivacy.retry') }}
    </button>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useBridgePrivacyStore } from '@/stores/useBridgePrivacy'
import { useServerChannelStore } from '@/stores/useServerChannel'

const { t } = useI18n()
const store = useBridgePrivacyStore()
const servers = useServerChannelStore()
const serverName = computed(() => servers.servers.find(server => server.id === store.serverId)?.name)
</script>

<style scoped>
.privacy-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1rem; }
.privacy-hint { color: var(--text-secondary); font-size: 0.875rem; }
</style>
