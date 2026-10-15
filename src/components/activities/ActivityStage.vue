<!-- The call overlay's activity view: the player's slot, controls and the queue. -->
<template>
  <section class="activity-stage" :aria-label="t('activities.region')" data-testid="activity-stage">
    <header class="activity-stage__head">
      <span class="activity-stage__badge" :class="`is-${activity.source}`">
        <Icon :name="sourceIcon" :size="13" />{{ sourceLabel }}
      </span>
      <h2 class="activity-stage__title" data-testid="activity-title">{{ title }}</h2>
      <button type="button" class="activity-stage__ghost" data-testid="activity-hide" @click="actStore.hide(activity.channel_id, true)">
        {{ t('activities.hideForMe') }}
      </button>
      <button
        v-if="canControl"
        type="button"
        class="activity-stage__ghost activity-stage__ghost--end"
        :disabled="actStore.busy"
        data-testid="activity-end"
        @click="actStore.stop()"
      >
        {{ t('activities.endForEveryone') }}
      </button>
    </header>

    <div ref="slotEl" class="activity-stage__screen" :class="{ 'is-listen': listen }" data-testid="activity-slot">
      <p v-if="actStore.status.error === 'autoplay'" class="activity-stage__notice">
        <button type="button" class="activity-stage__resume" @click="resume">{{ t('activities.clickToPlay') }}</button>
      </p>
      <p v-else-if="actStore.status.error" class="activity-stage__notice activity-stage__notice--error" role="status" data-testid="activity-error">
        <span>{{ t('activities.playerError') }}</span>
        <a v-if="sourceUrl" :href="sourceUrl" target="_blank" rel="noopener noreferrer" class="activity-stage__resume">
          {{ t('activities.openOn', { service: sourceLabel }) }}
        </a>
      </p>
    </div>

    <ActivityControls :activity="activity">
      <template #extra>
        <button
          v-if="voice.liveReactionsAvailable"
          ref="reactButton"
          type="button"
          class="activity-stage__queue-btn"
          :aria-label="t('voice.react')"
          :title="t('voice.react')"
          aria-haspopup="dialog"
          :aria-expanded="reactOpen"
          data-testid="activity-react"
          @click="reactOpen = !reactOpen"
        >
          <Icon name="smile-plus" :size="16" />
        </button>
        <button
          type="button"
          class="activity-stage__queue-btn"
          :aria-expanded="queueOpen"
          data-testid="activity-queue-toggle"
          @click="queueOpen = !queueOpen"
        >
          <Icon name="list-video" :size="16" />
          <span>{{ t('activities.queue') }}</span>
          <span v-if="activity.queue.length" class="activity-stage__count">{{ activity.queue.length }}</span>
        </button>
      </template>
    </ActivityControls>

    <div v-if="queueOpen" class="activity-stage__queue" data-testid="activity-queue">
      <ol v-if="activity.queue.length" class="activity-stage__list">
        <li v-for="(entry, i) in activity.queue" :key="`${i}-${entry.item.title}`" class="activity-stage__entry">
          <span class="activity-stage__index">{{ i + 1 }}</span>
          <span class="activity-stage__entry-title">{{ entry.item.title || fallbackTitle(entry.source) }}</span>
          <button type="button" class="activity-stage__icon" :aria-label="t('activities.playNow')" @click="actStore.control({ action: 'jump', index: i })">
            <Icon name="play" :size="14" />
          </button>
          <button type="button" class="activity-stage__icon" :aria-label="t('activities.removeFromQueue')" @click="actStore.control({ action: 'dequeue', index: i })">
            <Icon name="x" :size="14" />
          </button>
        </li>
      </ol>
      <p v-else class="activity-stage__empty">{{ t('activities.queueEmpty') }}</p>
      <button type="button" class="activity-stage__add" data-testid="activity-queue-add" @click="actStore.launcherOpen = true">
        <Icon name="plus" :size="15" />{{ t('activities.addToQueue') }}
      </button>
    </div>

    <LiveReactionPopover
      :visible="reactOpen && voice.liveReactionsAvailable"
      :anchor="reactButton"
      :target="ACTIVITY_REACTION_TARGET"
      @close="reactOpen = false"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { useActivitiesStore } from '@/stores/activities'
import { isListenActivity, type ActivitySource, type VoiceActivity } from '@/services/activities/activityService'
import LiveReactionPopover from '@/components/voice/LiveReactionPopover.vue'
import { ACTIVITY_REACTION_TARGET } from '@/services/voice/liveReactions'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import ActivityControls from './ActivityControls.vue'
import { activitySourceIcon, activitySourceLabel, activitySourceUrl } from './activitySources'
import { useActivityControl } from './useActivityControl'

const props = defineProps<{ activity: VoiceActivity }>()

const { t } = useT()
const actStore = useActivitiesStore()
const voice = useUnifiedVoiceChannelStore()
const { canControl } = useActivityControl(() => props.activity)
const slotEl = ref<HTMLElement | null>(null)
const queueOpen = ref(false)
const reactOpen = ref(false)
const reactButton = ref<HTMLButtonElement | null>(null)
let release: (() => void) | null = null

const listen = computed(() => isListenActivity(props.activity.source, props.activity.item))
const sourceIcon = computed(() => activitySourceIcon(props.activity.source))
const sourceLabel = computed(() => activitySourceLabel(props.activity.source, t))
const title = computed(() => props.activity.item.title || fallbackTitle(props.activity.source))
const sourceUrl = computed(() => activitySourceUrl(props.activity.source, props.activity.item))

function fallbackTitle(source: ActivitySource): string {
  return activitySourceLabel(source, t)
}

function resume(): void {
  actStore.setStatus({ error: null })
  document.querySelector<HTMLMediaElement>('[data-testid="activity-media"]')?.play().catch(() => {})
}

onMounted(() => {
  if (slotEl.value) release = actStore.registerSlot(slotEl.value)
})

onBeforeUnmount(() => release?.())
</script>

<style scoped>
.activity-stage {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0 auto;
}

.activity-stage__head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.activity-stage__badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 3px 9px;
  background: rgb(255 255 255 / 0.08);
  border-radius: var(--radius-full);
  font-size: 12px;
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
}

.activity-stage__badge.is-youtube { color: #ff4e45; }
.activity-stage__badge.is-soundcloud { color: #ff7a1a; }
.activity-stage__badge.is-spotify { color: #1ed760; }

.activity-stage__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: var(--font-size-md, 15px);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-stage__ghost {
  flex-shrink: 0;
  padding: 4px 10px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  font: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}

.activity-stage__ghost:hover {
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.activity-stage__ghost--end {
  color: var(--text-danger);
  border-color: color-mix(in srgb, var(--text-danger) 45%, transparent);
}

.activity-stage__ghost--end:hover:not(:disabled) {
  color: var(--text-on-primary, #fff);
  background: var(--error);
  border-color: var(--error);
}

.activity-stage__screen {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  min-height: 160px;
  background: #000;
  border-radius: 10px;
}

.activity-stage__screen.is-listen {
  flex: 0 0 auto;
  height: clamp(180px, calc(36 * var(--app-vh)), 360px);
}

.activity-stage__notice {
  position: absolute;
  inset: 0;
  z-index: 10005;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
}

.activity-stage__notice--error {
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  background: rgb(0 0 0 / 0.82);
  border-radius: 10px;
  color: #fff;
  font-size: 14px;
  text-align: center;
}

.activity-stage__resume {
  padding: 10px 18px;
  text-decoration: none;
  background: var(--harmony-primary-fill, var(--harmony-primary));
  border: none;
  border-radius: var(--radius-full);
  font: inherit;
  font-weight: var(--font-weight-semibold);
  color: var(--text-on-primary, #fff);
  cursor: pointer;
}

.activity-stage__queue-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 32px;
  padding: 0 10px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  font: inherit;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}

.activity-stage__queue-btn[aria-expanded='true'],
.activity-stage__queue-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.activity-stage__count {
  min-width: 18px;
  padding: 0 5px;
  background: var(--harmony-primary);
  border-radius: var(--radius-full);
  font-size: 11px;
  color: #fff;
}

.activity-stage__queue {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: rgb(255 255 255 / 0.04);
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.activity-stage__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.activity-stage__entry {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 4px 0 8px;
  border-radius: 6px;
  font-size: var(--font-size-sm);
}

.activity-stage__entry:hover {
  background: var(--background-modifier-hover);
}

.activity-stage__index {
  width: 18px;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.activity-stage__entry-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-stage__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
}

.activity-stage__icon:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.activity-stage__empty {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}

.activity-stage__add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 6px 10px;
  background: none;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.activity-stage__add:hover {
  color: var(--text-primary);
  border-color: var(--harmony-primary);
}
</style>
