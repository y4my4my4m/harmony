<template>
  <UnifiedModal :model-value="!!store.serverId" :title="t('bridgePrivacy.title')" :subtitle="serverName" size="sm"
    @update:model-value="(open: boolean) => { if (!open) store.close() }">
    <p :id="`${uid}-description`">{{ t('bridgePrivacy.description') }}</p>
    <p :id="`${uid}-scope`" class="privacy-hint">{{ t('bridgePrivacy.scope') }}</p>
    <div v-if="store.loading" role="status" :aria-label="t('bridgePrivacy.loading')"><LoadingSpinner /></div>
    <template v-else-if="store.privacy">
      <p v-if="store.platforms.length === 0" class="privacy-hint" data-testid="bridge-privacy-none">{{ t('bridgePrivacy.none') }}</p>
      <div v-for="platform in store.platforms" :key="platform" class="privacy-row" :data-platform="platform">
        <span :id="`${uid}-${platform}-label`">{{ t('bridgePrivacy.optOut', { platform: bridgePlatformLabel(platform) }) }}</span>
        <ToggleSwitch :model-value="store.privacy[platform].opted_out" :disabled="store.saving || !!store.error"
          :labelledby="`${uid}-${platform}-label`" :describedby="`${uid}-description ${uid}-scope`"
          @update:model-value="store.setOptOut(platform, $event)" />
      </div>
    </template>
    <p v-if="store.saving" role="status">{{ t('bridgePrivacy.saving') }}</p>
    <p v-if="store.error" role="alert">{{ t(`bridgePrivacy.${store.error}`) }}</p>
    <button v-if="store.error" type="button" class="btn btn-secondary" @click="store.open(store.serverId!)">
      {{ t('bridgePrivacy.retry') }}
    </button>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useBridgePrivacyStore } from '@/stores/useBridgePrivacy'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { bridgePlatformLabel } from '@/utils/messageAuthor'

const { t } = useI18n()
const store = useBridgePrivacyStore()
const uid = `bridge-privacy-${useId()}`
const servers = useServerChannelStore()
const serverName = computed(() => servers.servers.find(server => server.id === store.serverId)?.name)
</script>

<style scoped>
.privacy-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1rem; }
.privacy-hint { color: var(--text-secondary); font-size: 0.875rem; }
</style>
