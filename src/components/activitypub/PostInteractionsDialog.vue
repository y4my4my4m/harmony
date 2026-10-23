<!-- Accounts that favourited or boosted a post, one tab each, newest first. The counts are the
     post's own; accounts known only to other servers end the list as one line. -->
<template>
  <BaseModal
    :show="true"
    :show-header="false"
    overlay-class="post-interactions-modal"
    initial-focus="[role='tab'][aria-selected='true']"
    @close="emit('close')"
  >
    <div class="interactions-layout" data-testid="post-interactions-dialog">
      <header class="interactions-header">
        <h2 class="interactions-title">{{ t('activitypub.interactionsList.title') }}</h2>
        <button
          type="button"
          class="interactions-close"
          :aria-label="t('common.close')"
          :title="t('common.close')"
          @click="emit('close')"
        >
          <Icon name="close" :size="16" />
        </button>
      </header>

      <div
        ref="tablistRef"
        class="interactions-tabs"
        role="tablist"
        :aria-label="t('activitypub.interactionsList.title')"
        @keydown="onTabKeydown"
      >
        <button
          v-for="tab in TABS"
          :id="tabIds[tab]"
          :key="tab"
          type="button"
          role="tab"
          class="interactions-tab"
          :class="{ active: tab === activeTab }"
          :aria-selected="tab === activeTab"
          :aria-controls="panelId"
          :tabindex="tab === activeTab ? 0 : -1"
          :data-testid="`post-interactions-tab-${tab}`"
          @click="activeTab = tab"
        >
          <Icon :name="TAB_ICON[tab]" :size="16" />
          <span>{{ t(TAB_LABEL[tab]) }}</span>
          <span class="interactions-tab-count">{{ formatCount(countFor(tab)) }}</span>
        </button>
      </div>

      <div
        :id="panelId"
        class="interactions-panel"
        role="tabpanel"
        :aria-labelledby="tabIds[activeTab]"
        :aria-busy="active.loading ? 'true' : 'false'"
        data-testid="post-interactions-panel"
      >
        <div v-if="active.loading && active.accounts.length === 0" class="loading-state interactions-loading">
          <LoadingSpinner :size="28" />
          <p class="loading-state-label">{{ t('common.loading') }}</p>
        </div>

        <EmptyState
          v-else-if="active.error && active.accounts.length === 0"
          size="sm"
          tone="error"
          icon="alert-triangle"
          :title="t('activitypub.interactionsList.loadFailed')"
          :action-label="t('common.retry')"
          @action="load(activeTab)"
        />

        <template v-else-if="active.loaded">
          <ul v-if="active.accounts.length > 0" ref="listRef" class="interactions-list">
            <li v-for="account in active.accounts" :key="account.interactionId">
              <RouterLink
                :to="{ name: 'UserProfile', params: { handle: account.routeHandle } }"
                class="interactions-account"
                data-testid="post-interactions-account"
                @click="onAccountClick"
              >
                <Avatar :src="account.avatarUrl" alt="" size="sm" class="interactions-avatar" />
                <span class="interactions-account-text">
                  <span class="interactions-account-name">
                    <DisplayName :user-id="account.id" :fallback="account.displayName" />
                  </span>
                  <span class="interactions-account-handle">{{ account.handle }}</span>
                </span>
              </RouterLink>
            </li>
          </ul>

          <EmptyState
            v-else-if="hiddenCount === 0"
            size="sm"
            :icon="TAB_ICON[activeTab]"
            :title="t(EMPTY_LABEL[activeTab])"
            data-testid="post-interactions-empty"
          />

          <div v-if="active.hasMore" class="interactions-more">
            <button
              type="button"
              class="interactions-more-button"
              data-testid="post-interactions-more"
              :aria-disabled="active.loading ? 'true' : undefined"
              @click="loadMore"
            >
              {{ active.loading ? t('common.loading') : t('activitypub.showMore') }}
            </button>
            <p v-if="active.error" class="interactions-more-error" role="alert">
              {{ t('activitypub.interactionsList.loadFailed') }}
            </p>
          </div>

          <p
            v-else-if="hiddenCount > 0"
            class="interactions-elsewhere"
            data-testid="post-interactions-elsewhere"
          >
            {{ t(
              active.accounts.length > 0
                ? 'activitypub.interactionsList.moreElsewhere'
                : 'activitypub.interactionsList.onlyElsewhere',
              { count: formatCount(hiddenCount) },
              hiddenCount,
            ) }}
          </p>
        </template>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/BaseModal.vue'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import DisplayName from '@/components/DisplayName.vue'
import { uid } from '@/utils/a11y/focus'
import {
  fetchInteractionAccounts,
  type InteractionAccount,
  type ListedInteraction,
} from '@/services/postInteractionAccounts'

const props = defineProps<{
  /** The original post: a pure boost's interactions are its target's. */
  postId: string
  initialTab: ListedInteraction
  favoritesCount: number
  boostsCount: number
}>()

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()

const TABS: ListedInteraction[] = ['favorite', 'reblog']
const TAB_ICON: Record<ListedInteraction, string> = { favorite: 'heart', reblog: 'reblog' }
const TAB_LABEL: Record<ListedInteraction, string> = {
  favorite: 'activitypub.interactionsList.favorites',
  reblog: 'activitypub.interactionsList.boosts',
}
const EMPTY_LABEL: Record<ListedInteraction, string> = {
  favorite: 'activitypub.interactionsList.emptyFavorites',
  reblog: 'activitypub.interactionsList.emptyBoosts',
}

interface TabState {
  accounts: InteractionAccount[]
  nextOffset: number
  hasMore: boolean
  loaded: boolean
  loading: boolean
  error: boolean
}

const blank = (): TabState => ({
  accounts: [],
  nextOffset: 0,
  hasMore: false,
  loaded: false,
  loading: false,
  error: false,
})

const tabs = reactive<Record<ListedInteraction, TabState>>({ favorite: blank(), reblog: blank() })
const activeTab = ref<ListedInteraction>(props.initialTab)
const active = computed(() => tabs[activeTab.value])

const panelId = uid('post-interactions-panel')
const tabIds: Record<ListedInteraction, string> = {
  favorite: uid('post-interactions-tab'),
  reblog: uid('post-interactions-tab'),
}

const tablistRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)

/** The post's count; a fully listed tab never shows fewer than its rows. */
const countFor = (tab: ListedInteraction) => {
  const count = tab === 'favorite' ? props.favoritesCount : props.boostsCount
  return Math.max(count, tabs[tab].accounts.length)
}

const hiddenCount = computed(() => {
  const state = active.value
  if (!state.loaded || state.hasMore) return 0
  return Math.max(0, countFor(activeTab.value) - state.accounts.length)
})

/** Appends the next page when `more`; resolves to the number of accounts added. */
const load = async (tab: ListedInteraction, more = false): Promise<number> => {
  const state = tabs[tab]
  if (state.loading) return 0
  state.loading = true
  state.error = false
  try {
    const page = await fetchInteractionAccounts(props.postId, tab, more ? state.nextOffset : 0)
    // Offset paging: a row inserted between pages shifts the next page by one.
    const seen = new Set(more ? state.accounts.map((a) => a.interactionId) : [])
    const fresh = page.accounts.filter((a) => !seen.has(a.interactionId))
    state.accounts = more ? [...state.accounts, ...fresh] : fresh
    state.nextOffset = page.nextOffset
    state.hasMore = page.hasMore
    state.loaded = true
    return fresh.length
  } catch {
    state.error = true
    return 0
  } finally {
    state.loading = false
  }
}

watch(activeTab, (tab) => {
  const state = tabs[tab]
  if (!state.loaded && !state.loading) void load(tab)
}, { immediate: true })

// Focus moves to the first account added; the button may be gone with the last page.
const loadMore = async () => {
  if (active.value.loading) return
  const before = active.value.accounts.length
  const added = await load(activeTab.value, true)
  if (added === 0) return
  await nextTick()
  listRef.value?.querySelectorAll<HTMLElement>('.interactions-account')[before]?.focus()
}

// A plain click navigates; modified clicks open elsewhere and keep the dialog.
const onAccountClick = (event: MouseEvent) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  emit('close')
}

// WAI-ARIA tabs pattern: arrows move selection and focus, Home/End jump to the ends.
const onTabKeydown = (event: KeyboardEvent) => {
  const current = TABS.indexOf(activeTab.value)
  let next: number
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (current + 1) % TABS.length
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (current - 1 + TABS.length) % TABS.length
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = TABS.length - 1
      break
    default:
      return
  }
  event.preventDefault()
  activeTab.value = TABS[next]
  void nextTick(() => {
    tablistRef.value?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  })
}

const formatCount = (count: number) => {
  if (count < 1000) return count.toString()
  if (count < 10000) return (count / 1000).toFixed(1) + 'K'
  if (count < 1000000) return Math.floor(count / 1000) + 'K'
  return (count / 1000000).toFixed(1) + 'M'
}
</script>

<style scoped>
.interactions-layout {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.interactions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 12px;
  flex-shrink: 0;
}

.interactions-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text-primary);
}

.interactions-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
  flex-shrink: 0;
}

.interactions-close:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.interactions-tabs {
  display: flex;
  gap: 6px;
  padding: 0 16px 8px;
  border-bottom: 1px solid var(--border-secondary);
  flex-shrink: 0;
}

.interactions-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: var(--font-size-sm);
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.interactions-tab:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.interactions-tab.active {
  background: var(--harmony-primary-alpha);
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}

.interactions-tab-count {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.interactions-tab:focus-visible,
.interactions-account:focus-visible,
.interactions-close:focus-visible,
.interactions-more-button:focus-visible {
  outline: 2px solid var(--border-focus, var(--harmony-primary));
  outline-offset: -2px;
}

.interactions-panel {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}

.interactions-loading {
  padding: var(--space-8) var(--space-4);
  color: var(--text-muted);
}

.interactions-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.interactions-account {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  color: inherit;
  text-decoration: none;
  transition: background-color 0.15s ease;
}

.interactions-account:hover {
  background: var(--background-modifier-hover);
}

.interactions-avatar {
  flex-shrink: 0;
}

.interactions-account-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.interactions-account-name {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.interactions-account-handle {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.interactions-more {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0 var(--space-1);
}

.interactions-more-button {
  min-height: 36px;
  padding: 6px 16px;
  background: transparent;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
  font: inherit;
  font-size: var(--font-size-sm);
  transition: background-color 0.15s ease;
}

.interactions-more-button:hover {
  background: var(--background-modifier-hover);
}

.interactions-more-button[aria-disabled='true'] {
  cursor: progress;
  color: var(--text-muted);
}

.interactions-more-error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-danger, var(--status-danger));
}

.interactions-elsewhere {
  margin: 0;
  padding: var(--space-3) 8px var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  text-align: center;
}

@media (max-width: 768px), (pointer: coarse) {
  .interactions-tab {
    min-height: 40px;
    flex: 1;
    justify-content: center;
  }

  .interactions-account {
    min-height: 52px;
  }

  .interactions-more-button {
    min-height: 44px;
    width: 100%;
  }
}
</style>

<!-- Unscoped: BaseModal teleports to body. The overlay class outranks BaseModal's
     scoped .modal-container/.modal-content rules (0,2,0) regardless of stylesheet order. -->
<style>
.modal-overlay.post-interactions-modal .modal-container {
  max-width: 460px;
  height: min(70 * var(--app-vh), 520px);
}

.modal-overlay.post-interactions-modal .modal-content {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

@media (max-width: 768px), (pointer: coarse) {
  .modal-overlay.post-interactions-modal .modal-container {
    height: min(80 * var(--app-vh), 560px);
  }
}
</style>
