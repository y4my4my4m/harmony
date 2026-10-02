<template>
  <header ref="headerRef" class="mony-header" :class="{ compact: isCompact, stacked: isStacked }">
    <div class="header-bar">
      <button
        v-if="isMobile"
        type="button"
        class="icon-btn"
        :aria-label="t('activitypub.openNavigation')"
        :title="t('activitypub.openNavigation')"
        @click="$emit('toggle-left-sidebar')"
      >
        <Icon name="menu" :size="20" />
      </button>

      <span v-if="isStacked" class="header-brand">{{ instanceSettings.settings.instanceName }}</span>

      <div
        v-else
        class="feed-tabs"
        role="tablist"
        :aria-label="t('activitypub.timelines')"
        @keydown="handleTabKeydown"
      >
        <button
          v-for="tab in feedTabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="currentView === tab.id"
          :tabindex="currentView === tab.id ? 0 : -1"
          :class="['feed-tab', { active: currentView === tab.id }]"
          @click="$emit('switch-feed', tab.id)"
        >
          <Icon v-if="!isCompact" :name="tab.icon" :size="16" class="tab-icon" />
          <span class="tab-label">{{ tab.label }}</span>
        </button>
      </div>

      <div class="header-actions">
        <button
          type="button"
          class="icon-btn"
          :aria-label="t('activitypub.searchAction')"
          :title="t('activitypub.searchAction')"
          @click="$emit('open-search')"
        >
          <Icon name="search" :size="18" />
        </button>

        <button
          v-if="!isStacked"
          type="button"
          class="icon-btn"
          :aria-label="t('activitypub.refreshAction')"
          :title="t('activitypub.refreshAction')"
          @click="$emit('refresh-timeline')"
        >
          <Icon name="refresh-cw" :size="18" />
        </button>

        <button
          v-if="!isMobile"
          type="button"
          class="icon-btn"
          :class="{ active: rightSidebarOpen }"
          :aria-label="t('activitypub.toggleSidebarAction')"
          :aria-pressed="rightSidebarOpen"
          :title="t('activitypub.toggleSidebarAction')"
          @click="$emit('toggle-right-sidebar')"
        >
          <Icon name="panel-right" :size="18" />
        </button>

        <button
          type="button"
          class="new-post-btn"
          :class="{ 'icon-only': isCompact || isStacked }"
          data-testid="compose-btn"
          :aria-label="t('activitypub.newPost')"
          :title="t('activitypub.newPost')"
          @click="$emit('open-composer')"
        >
          <Icon name="plus" :size="18" />
          <span v-if="!isCompact && !isStacked">{{ t('activitypub.newPost') }}</span>
        </button>
      </div>
    </div>

    <div
      v-if="isStacked"
      class="feed-tabs feed-tabs--row"
      role="tablist"
      :aria-label="t('activitypub.timelines')"
      @keydown="handleTabKeydown"
    >
      <button
        v-for="tab in feedTabs"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="currentView === tab.id"
        :tabindex="currentView === tab.id ? 0 : -1"
        :class="['feed-tab', { active: currentView === tab.id }]"
        @click="$emit('switch-feed', tab.id)"
      >
        <span class="tab-label">{{ tab.label }}</span>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'

const { t } = useI18n()
const instanceSettings = useInstanceSettingsStore()

interface Props {
  currentView?: string
  isMobile?: boolean
  rightSidebarOpen?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  currentView: 'home',
  isMobile: false,
  rightSidebarOpen: false
})

defineEmits<{
  'switch-feed': [feedType: string]
  'refresh-timeline': []
  'open-composer': []
  'open-search': []
  'toggle-left-sidebar': []
  'toggle-right-sidebar': []
}>()

// Header width (px) below which tab icons and the "New post" label drop out,
// and below which the tabs move to their own row.
const COMPACT_WIDTH = 720
const STACKED_WIDTH = 560

const headerRef = ref<HTMLElement | null>(null)
const headerWidth = ref(Number.POSITIVE_INFINITY)
let resizeObserver: ResizeObserver | null = null

const isStacked = computed(() => props.isMobile || headerWidth.value < STACKED_WIDTH)
const isCompact = computed(() => headerWidth.value < COMPACT_WIDTH)

onMounted(() => {
  if (!headerRef.value) return
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      headerWidth.value = entry.contentRect.width
    }
  })
  resizeObserver.observe(headerRef.value)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})

const allFeedTabs = [
  { id: 'home', labelKey: 'activitypub.home', icon: 'home', requiresFederation: false },
  { id: 'local', labelKey: 'activitypub.local', icon: 'users', requiresFederation: false },
  { id: 'public', labelKey: 'activitypub.federated', icon: 'globe', requiresFederation: true },
  { id: 'trending', labelKey: 'activitypub.trending', icon: 'trending-up', requiresFederation: false },
  { id: 'instances', labelKey: 'activitypub.instances', icon: 'server', requiresFederation: true }
]

const feedTabs = computed(() =>
  allFeedTabs
    .filter(tab => !tab.requiresFederation || instanceSettings.isFederationEnabled)
    .map(tab => ({ id: tab.id, icon: tab.icon, label: t(tab.labelKey) }))
)

// Roving focus across the tablist (WAI-ARIA tabs pattern, manual activation).
const handleTabKeydown = (event: KeyboardEvent) => {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const list = event.currentTarget as HTMLElement
  const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
  if (index === -1) return
  event.preventDefault()
  let next = index
  if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = tabs.length - 1
  tabs[next]?.focus()
}
</script>

<style scoped>
.mony-header {
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.header-bar {
  display: flex;
  align-items: stretch;
  gap: var(--space-2);
  /* 47px plus the header's 1px border: 48, the height of every column header. */
  height: 47px;
  padding: 0 var(--space-3) 0 var(--space-2);
}

.header-brand {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  padding-left: var(--space-1);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.feed-tabs {
  display: flex;
  align-items: stretch;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.feed-tabs::-webkit-scrollbar {
  display: none;
}

.feed-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.feed-tab:hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.feed-tab.active {
  color: var(--text-primary);
}

.feed-tab.active::after {
  content: '';
  position: absolute;
  left: var(--space-3);
  right: var(--space-3);
  bottom: 0;
  height: 3px;
  border-radius: 3px 3px 0 0;
  background: var(--harmony-primary);
}

.tab-icon {
  flex-shrink: 0;
}

.feed-tabs--row {
  flex: none;
  height: 44px;
  padding: 0 var(--space-1);
  border-top: 1px solid var(--border-color);
}

.feed-tabs--row .feed-tab {
  flex: 1 0 auto;
  padding: 0 var(--space-3);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  margin-left: auto;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.icon-btn:hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

/* Open panel. */
.icon-btn.active {
  color: var(--icon-active);
  background: var(--background-modifier-selected);
}

.new-post-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 36px;
  margin-left: var(--space-1);
  padding: 0 var(--space-4) 0 var(--space-3);
  border: none;
  border-radius: var(--radius-full);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.new-post-btn:hover {
  background: var(--harmony-primary-hover);
}

.new-post-btn.icon-only {
  width: 36px;
  padding: 0;
  justify-content: center;
}

.feed-tab:focus-visible,
.icon-btn:focus-visible,
.new-post-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
}

@media (max-width: 768px) {
  .header-bar {
    height: 52px;
  }

  .icon-btn,
  .new-post-btn.icon-only {
    width: 40px;
    height: 40px;
  }
}
</style>
