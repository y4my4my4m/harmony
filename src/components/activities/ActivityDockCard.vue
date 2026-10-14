<!-- The call's activity above the dock: a small view of the player, its title and controls. -->
<template>
  <div class="activity-dock" data-testid="activity-dock-card">
    <div ref="slotEl" class="activity-dock__slot" :class="{ 'is-listen': listen }" />
    <div class="activity-dock__body">
      <div class="activity-dock__line">
        <Icon :name="activitySourceIcon(activity.source)" :size="13" class="activity-dock__icon" />
        <span class="activity-dock__title">{{ activity.item.title || activitySourceLabel(activity.source, t) }}</span>
        <button type="button" class="activity-dock__open" :aria-label="t('activities.open')" :title="t('activities.open')" data-testid="activity-open" @click="voice.isOverlayVisible = true">
          <Icon name="maximize-2" :size="14" />
        </button>
      </div>
      <ActivityControls :activity="activity" compact />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { useActivitiesStore } from '@/stores/activities'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { isListenActivity, type VoiceActivity } from '@/services/activities/activityService'
import ActivityControls from './ActivityControls.vue'
import { activitySourceIcon, activitySourceLabel } from './activitySources'

const props = defineProps<{ activity: VoiceActivity }>()

const { t } = useT()
const actStore = useActivitiesStore()
const voice = useUnifiedVoiceChannelStore()
const slotEl = ref<HTMLElement | null>(null)
let release: (() => void) | null = null

const listen = computed(() => isListenActivity(props.activity.source, props.activity.item))

onMounted(() => {
  if (slotEl.value) release = actStore.registerSlot(slotEl.value)
})
onBeforeUnmount(() => release?.())
</script>

<style scoped>
.activity-dock {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px;
  background: var(--background-floating, var(--background-secondary));
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
}

.activity-dock__slot {
  flex-shrink: 0;
  width: 112px;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 8px;
}

.activity-dock__slot.is-listen {
  width: 56px;
  aspect-ratio: 1 / 1;
}

.activity-dock__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.activity-dock__line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.activity-dock__icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.activity-dock__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-dock__open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
}

.activity-dock__open:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}
</style>
