<!-- What a voice channel's activity plays, under the channel in the sidebar. -->
<template>
  <div class="voice-activity-line" data-testid="voice-activity-line" :title="label">
    <span class="voice-activity-line__icon" :class="`is-${activity.source}`"><Icon :name="activitySourceIcon(activity.source)" :size="12" /></span>
    <span class="voice-activity-line__verb">{{ listen ? t('activities.listening') : t('activities.watching') }}</span>
    <span class="voice-activity-line__title">{{ title }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { isListenActivity, type VoiceActivity } from '@/services/activities/activityService'
import { activitySourceIcon, activitySourceLabel } from './activitySources'

const props = defineProps<{ activity: VoiceActivity }>()
const { t } = useT()

const listen = computed(() => isListenActivity(props.activity.source, props.activity.item))
const title = computed(() => props.activity.item.title || activitySourceLabel(props.activity.source, t))
const label = computed(() => `${listen.value ? t('activities.listening') : t('activities.watching')} ${title.value}`)
</script>

<style scoped>
.voice-activity-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin: 2px 8px 2px 34px;
  padding: 3px 8px;
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.voice-activity-line__icon {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--harmony-primary);
}

.voice-activity-line__icon.is-youtube { color: #ff4e45; }
.voice-activity-line__icon.is-soundcloud { color: #ff7a1a; }
.voice-activity-line__icon.is-spotify { color: #1ed760; }

.voice-activity-line__verb {
  flex-shrink: 0;
  font-weight: var(--font-weight-semibold);
}

.voice-activity-line__title {
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
