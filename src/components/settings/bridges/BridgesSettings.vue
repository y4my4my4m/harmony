<template>
  <section class="bridges-settings" :aria-labelledby="`${uid}-title`" data-testid="bridges-settings">
    <div class="settings-section">
      <h2 :id="`${uid}-title`" class="section-title">{{ t('bridges.title') }}</h2>
      <p class="section-description">{{ t('bridges.intro') }}</p>
    </div>

    <div
      ref="tablistEl"
      class="bridges-tabs"
      role="tablist"
      :aria-labelledby="`${uid}-title`"
      @keydown="onTabsKeydown"
    >
      <button
        v-for="id in BRIDGE_TABS"
        :id="`${uid}-tab-${id}`"
        :key="id"
        type="button"
        role="tab"
        class="bridges-tab"
        :class="{ active: tab === id }"
        :data-tab="id"
        :data-testid="`bridges-tab-${id}`"
        :aria-selected="tab === id ? 'true' : 'false'"
        :aria-controls="`${uid}-panel-${id}`"
        :tabindex="tab === id ? 0 : -1"
        @click="select(id)"
      >
        {{ t(`bridges.tabs.${id}`) }}
      </button>
    </div>

    <div
      v-for="id in BRIDGE_TABS"
      v-show="tab === id"
      :id="`${uid}-panel-${id}`"
      :key="id"
      class="bridges-panel"
      role="tabpanel"
      :aria-labelledby="`${uid}-tab-${id}`"
      tabindex="0"
      :data-testid="`bridges-panel-${id}`"
    >
      <template v-if="visited.has(id)">
        <DiscordBridgeSetup
          v-if="id === 'discord'"
          :key="serverId"
          :server-id="serverId"
          :server-name="serverName"
          :link-return="linkReturn"
          :heading-level="3"
        />
        <MatrixBridgeSetup v-else :key="serverId" :server-id="serverId" />
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRovingTabindex } from '@/composables/useRovingTabindex'
import type { BridgeLinkReturn } from '@/utils/discordBridgeSetup'
import DiscordBridgeSetup from '@/components/settings/DiscordBridgeSetup.vue'
import MatrixBridgeSetup from '@/components/settings/matrix-bridge/MatrixBridgeSetup.vue'
import { BRIDGE_TABS, type BridgeTab } from './bridgesSection'

const props = withDefaults(
  defineProps<{
    serverId: string
    serverName?: string
    linkReturn?: BridgeLinkReturn | null
  }>(),
  { serverName: '', linkReturn: null },
)

const tab = defineModel<BridgeTab>('tab', { default: 'discord' })

const { t } = useI18n()
const uid = `bridges-${useId()}`
const tablistEl = ref<HTMLElement | null>(null)

/** Panels mount on their first visit and stay mounted; another server drops the hidden ones. */
const visited = reactive(new Set<BridgeTab>())
watch(tab, (id) => { visited.add(id) }, { immediate: true })
watch(() => props.serverId, () => {
  for (const id of [...visited]) if (id !== tab.value) visited.delete(id)
})

function select(id: BridgeTab) {
  tab.value = id
}

// Automatic activation: focus and selection move together.
const { onKeydown: onTabsKeydown } = useRovingTabindex(tablistEl, {
  itemSelector: '[role="tab"]',
  orientation: 'horizontal',
  onActivate: (item) => {
    select(item.dataset.tab as BridgeTab)
  },
})
</script>

<style scoped>
.bridges-settings {
  max-width: 860px;
}

.settings-section {
  margin-bottom: 16px;
}

.section-title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-description {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.bridges-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--background-quaternary);
}

.bridges-tab {
  padding: 10px 14px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  margin-bottom: -1px;
  transition: color 0.12s, border-color 0.12s;
}

.bridges-tab:hover {
  color: var(--text-primary);
}

.bridges-tab.active {
  color: var(--text-link);
  border-bottom-color: var(--harmony-primary);
}

.bridges-tab:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
}

.bridges-panel:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 4px;
  border-radius: 4px;
}
</style>
