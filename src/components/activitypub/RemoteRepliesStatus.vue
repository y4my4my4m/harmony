<!-- Reply crawl of a remote post in its thread: a placeholder row while it runs, then what
     came of it. Renders nothing once the replies are in the thread. -->
<template>
  <div
    v-if="view.kind === 'fetching'"
    class="remote-replies-status is-fetching"
    role="status"
    data-testid="remote-replies-fetching"
  >
    <div class="placeholder-row" aria-hidden="true">
      <span class="skeleton skeleton-avatar"></span>
      <span class="placeholder-lines">
        <span class="skeleton placeholder-line"></span>
        <span class="skeleton placeholder-line short"></span>
      </span>
    </div>
    <p class="status-text">{{ t('activitypub.repliesFetching', { domain }) }}</p>
  </div>
  <div
    v-else-if="notice"
    class="remote-replies-status"
    :class="`is-${notice.kind}`"
    role="status"
    :data-testid="`remote-replies-${view.kind}`"
  >
    <Icon :name="icon" :size="16" class="status-icon" />
    <p class="status-text">{{ message }}</p>
    <a
      v-if="showOrigin && originalUrl"
      :href="safeHref(originalUrl)"
      target="_blank"
      rel="noopener noreferrer"
      class="status-action"
    >
      {{ t('activitypub.viewOnDomain', { domain }) }}
    </a>
    <button v-if="canRetry" type="button" class="status-action" @click="emit('retry')">
      {{ t('common.retry') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { safeHref } from '@/utils/sanitize'
import { repliesFetchNotice, type RepliesFetchView } from '@/utils/remoteReplies'

const props = defineProps<{
  view: RepliesFetchView
  domain: string
  originalUrl?: string | null
}>()

const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()

/** Kinds whose outcome the thread itself shows. */
const SILENT = new Set<RepliesFetchView['kind']>(['fetching', 'fetched', 'recent', 'finished'])

const notice = computed(() => (SILENT.has(props.view.kind) ? null : repliesFetchNotice(props.view, props.domain)))

const message = computed(() => {
  const n = notice.value
  if (!n) return ''
  return n.count !== undefined ? t(n.key, n.params, n.count) : t(n.key, n.params)
})

const icon = computed(() => {
  switch (props.view.kind) {
    case 'rate_limited':
      return 'clock'
    case 'unreachable':
      return 'wifi-off'
    case 'unauthorized':
      return 'lock'
    case 'failed':
      return 'alert-circle'
    case 'partial':
      return 'external-link'
    default:
      return 'message-circle'
  }
})

const showOrigin = computed(() => ['partial', 'none', 'unauthorized'].includes(props.view.kind))
const canRetry = computed(() => ['rate_limited', 'unreachable', 'failed'].includes(props.view.kind))
</script>

<style scoped>
.remote-replies-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.remote-replies-status.is-fetching {
  flex-direction: column;
  align-items: stretch;
}

.remote-replies-status.is-error .status-icon {
  color: var(--error);
}

.placeholder-row {
  display: flex;
  gap: var(--space-3);
}

.skeleton-avatar {
  flex: none;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-full);
}

.placeholder-lines {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-1);
}

.placeholder-line {
  height: 12px;
  width: 70%;
}

.placeholder-line.short {
  width: 40%;
}

.status-icon {
  flex: none;
}

.status-text {
  flex: 1;
  min-width: 0;
  margin: 0;
}

.is-fetching .status-text {
  flex: none;
}

.status-action {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  text-decoration: none;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.status-action:hover {
  background: var(--background-modifier-hover);
}

.status-action:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .remote-replies-status {
    padding: var(--space-3);
  }
}
</style>
