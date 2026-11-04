<!--
  SupporterWall - supporter messages: the viewer's own that are not shown to others yet, with
  their state, then the approved ones, newest first. Bodies and names are text interpolation
  only: no markdown, links, mentions or emoji shortcodes. A body is clipped to two lines and a
  name to one, so no glyph run reaches outside its row. Admins hide a message from here.
-->
<template>
  <section class="supporter-wall" :aria-labelledby="headingId" :data-testid="testid">
    <h3 :id="headingId" class="supporter-wall__heading">{{ heading }}</h3>
    <ul v-if="ownPending.length || messages.length" class="supporter-wall__list">
      <li
        v-for="m in ownPending"
        :key="m.id"
        class="supporter-wall__item supporter-wall__item--own"
        data-testid="supporter-message-own"
      >
        <span class="supporter-wall__avatar supporter-wall__avatar--anon" aria-hidden="true">
          <Icon name="message-circle" :size="16" />
        </span>
        <div class="supporter-wall__text">
          <p class="supporter-wall__body" data-testid="supporter-message-body">{{ m.body }}</p>
          <p class="supporter-wall__meta">
            <span class="supporter-wall__name">{{ m.anonymous ? t('support.wall.anonymous') : t('support.wall.you') }}</span>
            <span class="supporter-wall__status" :data-state="ownState(m)">{{ ownStatus(m) }}</span>
          </p>
        </div>
        <button
          type="button"
          class="supporter-wall__action"
          data-testid="supporter-message-remove"
          @click="emit('remove', m.id)"
        >
          {{ t('support.message.remove') }}
        </button>
      </li>
      <li
        v-for="m in visible"
        :key="m.id"
        class="supporter-wall__item"
        data-testid="supporter-message"
      >
        <Avatar v-if="m.name && m.avatar_url" :src="m.avatar_url" size="sm" class="supporter-wall__avatar" />
        <span v-else class="supporter-wall__avatar supporter-wall__avatar--anon" aria-hidden="true">
          <Icon name="heart" :size="16" />
        </span>
        <div class="supporter-wall__text">
          <p class="supporter-wall__body" data-testid="supporter-message-body">{{ m.body }}</p>
          <p class="supporter-wall__meta">
            <span class="supporter-wall__name" data-testid="supporter-message-name">{{ m.name ?? t('support.wall.anonymous') }}</span>
            <time class="supporter-wall__time" :datetime="m.at" :title="fullTime(m.at)">{{ shortTime(m.at) }}</time>
          </p>
        </div>
        <button
          v-if="mineIds.has(m.id)"
          type="button"
          class="supporter-wall__action"
          data-testid="supporter-message-remove"
          @click="emit('remove', m.id)"
        >
          {{ t('support.message.remove') }}
        </button>
        <button
          v-else-if="canModerate"
          type="button"
          class="supporter-wall__action"
          data-testid="supporter-message-hide"
          :aria-label="t('support.wall.hideFrom', { name: m.name ?? t('support.wall.anonymous') })"
          @click="emit('hide', m.id)"
        >
          {{ t('support.wall.hide') }}
        </button>
      </li>
    </ul>
    <p v-else class="supporter-wall__empty">{{ emptyText }}</p>
    <button
      v-if="messages.length > limit"
      type="button"
      class="supporter-wall__more"
      :aria-expanded="expanded"
      data-testid="supporter-wall-more"
      @click="expanded = !expanded"
    >
      {{ expanded ? t('support.wall.fewer') : t('support.wall.more', { count: messages.length }) }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { uid } from '@/utils/a11y/focus'
import { formatFullDateTime, formatShortRelativeTime } from '@/utils/shortRelativeTime'
import type { MySupporterMessage } from '@/services/FundingService'
import { formatUntil } from './format'

export interface WallMessage {
  id: string
  body: string
  name: string | null
  avatar_url?: string | null
  at: string
}

const props = withDefaults(defineProps<{
  messages: WallMessage[]
  mine?: MySupporterMessage[]
  canModerate?: boolean
  heading: string
  emptyText: string
  testid?: string
  /** Messages shown before "Show all". */
  limit?: number
}>(), {
  mine: () => [],
  limit: 6,
  canModerate: false,
  testid: 'supporter-wall',
})

const emit = defineEmits<{ hide: [id: string]; remove: [id: string] }>()

const { t, locale } = useT()
const headingId = uid('supporter-wall')

const expanded = ref(false)
const visible = computed(() => (expanded.value ? props.messages : props.messages.slice(0, props.limit)))
const shown = computed(() => new Set(props.messages.map((m) => m.id)))
const ownPending = computed(() => props.mine.filter((m) => !shown.value.has(m.id)))
const mineIds = computed(() => new Set(props.mine.map((m) => m.id)))

const ownState = (m: MySupporterMessage) => (!m.attached ? 'waiting' : m.review)

const ownStatus = (m: MySupporterMessage): string => {
  if (!m.attached) {
    return t('support.message.status.waiting', { time: m.expires_at ? formatUntil(m.expires_at, locale.value) : '' })
  }
  return m.review === 'hidden' ? t('support.message.status.hidden') : t('support.message.status.pending')
}

const shortTime = (iso: string) => formatShortRelativeTime(iso, { locale: locale.value, nowLabel: t('support.wall.now') })
const fullTime = (iso: string) => formatFullDateTime(iso, locale.value)
</script>

<style scoped>
.supporter-wall__heading {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.supporter-wall__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.supporter-wall__item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
}

.supporter-wall__item:hover,
.supporter-wall__item:focus-within {
  background: var(--background-modifier-hover);
}

.supporter-wall__item--own {
  background: color-mix(in srgb, var(--harmony-primary) 8%, transparent);
  border: 1px dashed color-mix(in srgb, var(--harmony-primary) 45%, transparent);
}

.supporter-wall__avatar {
  flex-shrink: 0;
}

.supporter-wall__avatar--anon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: var(--background-modifier-active);
  border-radius: var(--radius-full);
  color: var(--text-secondary);
}

.supporter-wall__text {
  flex: 1;
  min-width: 0;
}

/* Two lines at most; the clip keeps tall or wide glyph runs inside the row. */
.supporter-wall__body {
  display: -webkit-box;
  max-height: calc(2 * 1.4em);
  margin: 0;
  overflow: hidden;
  font-size: var(--font-size-sm);
  line-height: 1.4;
  color: var(--text-primary);
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  contain: paint;
}

.supporter-wall__meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  margin: 2px 0 0;
  overflow: hidden;
  font-size: var(--font-size-xs);
  line-height: 1.4;
  color: var(--text-secondary);
}

.supporter-wall__name {
  min-width: 0;
  overflow: hidden;
  font-weight: var(--font-weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.supporter-wall__time,
.supporter-wall__status {
  flex-shrink: 0;
  white-space: nowrap;
}

.supporter-wall__status[data-state='hidden'] {
  color: var(--text-danger);
}

.supporter-wall__action {
  flex-shrink: 0;
  align-self: center;
  min-height: 28px;
  padding: 0 var(--space-2);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  cursor: pointer;
}

.supporter-wall__action:hover,
.supporter-wall__action:focus-visible {
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.supporter-wall__more {
  margin-top: var(--space-1);
  padding: var(--space-1) var(--space-3);
  background: none;
  border: none;
  border-radius: var(--radius-base);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-link);
  cursor: pointer;
}

.supporter-wall__more:hover {
  background: var(--background-modifier-hover);
}

.supporter-wall__more:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.supporter-wall__empty {
  margin: 0;
  padding: var(--space-3);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  text-align: center;
}
</style>
