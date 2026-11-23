<template>
  <div class="matrix-guide" data-testid="matrix-guide">
    <div v-if="blocked.length" class="db-banner db-banner--warn" data-testid="matrix-guide-blocked">
      <p class="blocked-title">{{ t('matrixBridge.guide.blockedTitle', blocked.length) }}</p>
      <ul class="blocked-list">
        <li v-for="item in blocked" :key="item.bot_id" :data-block="item.block">
          {{ t('matrixBridge.guide.blockedItem', { bot: item.bot_display_name, reason: t(`matrixBridge.guide.block.${item.block}`) }) }}
        </li>
      </ul>
    </div>

    <template v-if="showSteps">
      <h4 class="db-card-sub">{{ t('matrixBridge.guide.title') }}</h4>
      <p class="db-muted">{{ t('matrixBridge.guide.lead') }}</p>
      <ol class="db-steps" data-testid="matrix-guide-steps">
        <li>{{ t('matrixBridge.guide.steps.service') }}</li>
        <li>
          <i18n-t keypath="matrixBridge.guide.steps.bot" tag="span" scope="global">
            <template #place><span class="db-ui">{{ t('matrixBridge.guide.places.myBots') }}</span></template>
          </i18n-t>
        </li>
        <li>
          <i18n-t keypath="matrixBridge.guide.steps.install" tag="span" scope="global">
            <template #place><span class="db-ui">{{ t('matrixBridge.guide.places.serverBots') }}</span></template>
          </i18n-t>
        </li>
        <li>{{ t('matrixBridge.guide.steps.pair') }}</li>
      </ol>
    </template>

    <p class="db-muted guide-link">
      <a :href="MATRIX_BRIDGE_GUIDE_URL" target="_blank" rel="noopener noreferrer" data-testid="matrix-guide-link">
        {{ t('matrixBridge.guide.link') }}
        <Icon name="external-link" :size="12" aria-hidden="true" />
        <span class="db-sr-only">{{ t('matrixBridge.guide.newTab') }}</span>
      </a>
    </p>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { MATRIX_BRIDGE_GUIDE_URL, type MatrixBotBlock } from './matrixBridgeApi'

withDefaults(defineProps<{
  /** The caller's bots in this server that cannot bridge, with the first reason. */
  blocked?: { bot_id: string; bot_display_name: string; block: MatrixBotBlock }[]
  showSteps?: boolean
}>(), { blocked: () => [], showSteps: true })

const { t } = useI18n()
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.blocked-title {
  font-weight: 600;
}

.blocked-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.5;
}

.guide-link {
  margin-bottom: 0;
}

.guide-link a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
