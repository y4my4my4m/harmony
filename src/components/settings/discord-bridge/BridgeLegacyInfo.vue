<template>
  <details class="db-card db-details legacy" data-testid="legacy-info">
    <summary>{{ t('discordBridge.legacy.title') }}</summary>
    <p class="db-muted">{{ t('discordBridge.legacy.lead') }}</p>

    <div class="legacy-grid">
      <span class="db-label">{{ t('discordBridge.legacy.pairingCode') }}</span>
      <code class="db-inline-code" data-testid="legacy-code">{{ code }}</code>
      <span class="db-label">{{ t('discordBridge.legacy.serverId') }}</span>
      <code class="db-inline-code">{{ serverId }}</code>
    </div>

    <label class="co-located">
      <input v-model="coLocated" type="checkbox" />
      <span>{{ t('discordBridge.legacy.coLocated') }}</span>
    </label>

    <p class="db-muted">
      <i18n-t keypath="discordBridge.legacy.configHint" tag="span" scope="global">
        <template #file><code class="db-inline-code">config/bridge-config.yml</code></template>
        <template #command><code class="db-inline-code">docker compose up -d</code></template>
      </i18n-t>
    </p>
    <BridgeCopyBlock :text="yaml" :label="t('discordBridge.legacy.configLabel')">
      <button type="button" class="btn btn-secondary btn-sm" @click="download">
        <Icon name="download" :size="14" aria-hidden="true" />
        {{ t('discordBridge.legacy.download') }}
      </button>
      <button type="button" class="btn btn-secondary btn-sm" :disabled="regenerating" @click="regenerate">
        <Icon name="refresh-cw" :size="14" aria-hidden="true" />
        {{ t('discordBridge.legacy.regenerate') }}
      </button>
    </BridgeCopyBlock>

    <p class="db-muted">{{ t('discordBridge.legacy.intents') }}</p>
  </details>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import { buildBridgeGatewayUrls, generateBridgeConfigYaml } from '@/utils/discordBridgeSetup'
import { regenerateLegacyPairing } from './bridgeApi'
import { bridgeErrorKey } from './bridgeErrors'
import BridgeCopyBlock from './BridgeCopyBlock.vue'

const props = defineProps<{
  serverId: string
  pairingCode: string
  harmonyUrl: string
}>()

const { t } = useI18n()
const toast = useToast()
const code = ref(props.pairingCode)
const coLocated = ref(false)
const regenerating = ref(false)

const yaml = computed(() =>
  generateBridgeConfigYaml({
    pairingCode: code.value,
    serverId: props.serverId,
    gateway: buildBridgeGatewayUrls(props.harmonyUrl, coLocated.value),
  }),
)

function download() {
  const url = URL.createObjectURL(new Blob([yaml.value], { type: 'text/yaml' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'bridge-config.yml'
  anchor.click()
  URL.revokeObjectURL(url)
}

async function regenerate() {
  regenerating.value = true
  try {
    code.value = await regenerateLegacyPairing(props.serverId)
    toast.success(t('discordBridge.legacy.regenerated'))
  } catch (error) {
    debug.error('regenerate_discord_bridge_pairing failed:', error)
    toast.error(t(bridgeErrorKey(error, 'discordBridge.errors.generic')))
  } finally {
    regenerating.value = false
  }
}
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.legacy > summary {
  font-size: 15px;
}

.legacy-grid {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 8px 12px;
  align-items: center;
  margin-bottom: 12px;
}

.co-located {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-bottom: 12px;
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
}

.co-located input {
  margin-top: 3px;
}

@media (max-width: 520px) {
  .legacy-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
