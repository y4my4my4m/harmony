<template>
  <header class="view-header">
    <button
      v-if="isMobile"
      type="button"
      class="header-icon-btn"
      :aria-label="t('activitypub.openNavigation')"
      :title="t('activitypub.openNavigation')"
      @click="openLeftSidebar"
    >
      <Icon name="menu" :size="20" />
    </button>

    <button
      v-if="showBack"
      type="button"
      class="header-icon-btn"
      :aria-label="t('common.back')"
      :title="t('common.back')"
      @click="goBack"
    >
      <Icon name="arrow-left" :size="20" />
    </button>

    <div class="header-titles">
      <h1 class="header-title">
        <slot name="title">{{ resolvedTitle }}</slot>
      </h1>
      <p v-if="subtitle || $slots.subtitle" class="header-subtitle">
        <slot name="subtitle">{{ subtitle }}</slot>
      </p>
    </div>

    <div v-if="$slots.actions || showClearAll" class="header-actions">
      <slot name="actions" />
      <button
        v-if="showClearAll"
        type="button"
        class="header-text-btn danger"
        @click="$emit('clear-all')"
      >
        {{ t('activitypub.clearAllBookmarks') }}
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, type RouteLocationRaw } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import { useLayoutState } from '@/composables/useLayoutState'

interface Props {
  viewType?: string
  title?: string
  subtitle?: string
  dataCount?: number
  showBack?: boolean
  /** Destination when there is no in-app history to return to. */
  backFallback?: RouteLocationRaw
}

const props = withDefaults(defineProps<Props>(), {
  viewType: undefined,
  title: undefined,
  subtitle: undefined,
  dataCount: 0,
  showBack: true,
  backFallback: () => ({ name: 'SocialHome' }),
})

defineEmits<{
  'clear-all': []
}>()

const { t } = useI18n()
const router = useRouter()
const { isMobile, openLeftSidebar } = useLayoutState()

const VIEW_TITLE_KEYS: Record<string, string> = {
  explore: 'activitypub.explore',
  bookmarks: 'activitypub.bookmarks',
  lists: 'activitypub.lists',
  mentions: 'activitypub.mentions',
  profile: 'activitypub.profile',
  post: 'activitypub.post',
  notifications: 'activitypub.notifications',
}

const resolvedTitle = computed(() => {
  if (props.title) return props.title
  const key = props.viewType ? VIEW_TITLE_KEYS[props.viewType] : undefined
  return key ? t(key) : t('activitypub.home')
})

const showClearAll = computed(() => props.viewType === 'bookmarks' && props.dataCount > 0)

// history.state.back is set by vue-router for every in-app navigation.
const goBack = () => {
  if (window.history.state?.back) {
    router.back()
  } else {
    router.push(props.backFallback)
  }
}
</script>

<style scoped>
.view-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 48px;
  padding: var(--space-1) var(--space-4);
  border-bottom: 1px solid var(--border-color);
  background: var(--background-primary);
  flex-shrink: 0;
}

.header-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.header-icon-btn:hover {
  background: var(--background-modifier-hover);
}

.header-titles {
  flex: 1;
  min-width: 0;
  padding-left: var(--space-1);
}

.header-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  line-height: 1.25;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-subtitle {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: 1.3;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}

.header-text-btn {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.header-text-btn:hover {
  background: var(--background-modifier-hover);
}

.header-text-btn.danger:hover {
  color: var(--error);
  border-color: var(--error);
}

.header-icon-btn:focus-visible,
.header-text-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .view-header {
    padding: var(--space-2) var(--space-3);
  }

  .header-icon-btn {
    width: 40px;
    height: 40px;
  }
}
</style>
