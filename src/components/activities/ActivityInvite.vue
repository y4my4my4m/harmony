<!-- The call's activity before it plays here: who started it, what it is, and a choice. Shows the
     source and title only; the item's picture stays unloaded until the member joins. -->
<template>
  <div class="activity-invite" :class="{ 'is-dismissed': dismissed }" role="group" :aria-label="t('activities.region')" data-testid="activity-invite">
    <span class="activity-invite__icon" aria-hidden="true">
      <Icon :name="activitySourceIcon(activity.source)" :size="16" />
    </span>
    <div class="activity-invite__body">
      <p v-if="!dismissed && activity.host_id" class="activity-invite__who">
        <i18n-t keypath="activities.startedBy" scope="global">
          <template #name><DisplayName class="activity-invite__name" :user-id="activity.host_id" :truncate="true" /></template>
        </i18n-t>
      </p>
      <p class="activity-invite__what">
        <span class="activity-invite__source">{{ activitySourceLabel(activity.source, t) }}</span>
        <span v-if="activity.item.title" class="activity-invite__title">{{ activity.item.title }}</span>
      </p>
    </div>
    <div class="activity-invite__actions">
      <button type="button" class="activity-invite__join" data-testid="activity-join" @click="actStore.join()">
        {{ t('activities.join') }}
      </button>
      <button
        v-if="!dismissed"
        type="button"
        class="activity-invite__later"
        data-testid="activity-not-now"
        @click="actStore.hide(activity.channel_id, true)"
      >
        {{ t('activities.notNow') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import { useT } from '@/composables/useT'
import { useActivitiesStore } from '@/stores/activities'
import type { VoiceActivity } from '@/services/activities/activityService'
import { activitySourceIcon, activitySourceLabel } from './activitySources'

const props = defineProps<{ activity: VoiceActivity }>()

const { t } = useT()
const actStore = useActivitiesStore()
const dismissed = computed(() => actStore.hidden.has(props.activity.channel_id))
</script>

<style scoped>
.activity-invite {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--background-floating, var(--background-secondary));
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
}

.activity-invite__icon {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: var(--background-modifier-hover);
  border-radius: 8px;
  color: var(--text-secondary);
}

.activity-invite__body {
  flex: 1;
  min-width: 0;
}

.activity-invite__who,
.activity-invite__what {
  display: flex;
  gap: 6px;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
}

.activity-invite__who {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.activity-invite__name {
  max-width: 160px;
}

.activity-invite__what {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.activity-invite.is-dismissed .activity-invite__what {
  font-size: var(--font-size-sm);
}

.activity-invite__source {
  flex-shrink: 0;
  font-weight: var(--font-weight-semibold);
}

.activity-invite__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.activity-invite__actions {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
}

.activity-invite__join,
.activity-invite__later {
  padding: 5px 12px;
  border-radius: var(--radius-full);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.activity-invite__join {
  background: var(--harmony-primary-fill, var(--harmony-primary));
  border: none;
  color: var(--text-on-primary, #fff);
}

.activity-invite__join:hover {
  background: var(--harmony-primary-fill-hover, var(--harmony-primary-hover));
}

.activity-invite__later {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}

.activity-invite__later:hover {
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.activity-invite__join:focus-visible,
.activity-invite__later:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}
</style>
