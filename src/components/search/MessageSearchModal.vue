<template>
  <UnifiedModal
    :model-value="show"
    size="lg"
    full-height
    hide-header
    no-padding
    container-class="message-search-modal"
    @close="emit('close')"
    @open="focusInput"
  >
    <div class="search-shell">
      <div class="search-bar">
        <SearchQueryInput
          ref="queryInputRef"
          v-model:tokens="tokens"
          v-model:text="text"
          class="search-bar-input"
          :members="members"
          :channels="channels"
          :allow-channels="!conversationId"
          :placeholder="placeholder"
          @submit="runSearch(0)"
        />
        <button type="button" class="search-close" :aria-label="t('messageSearch.close')" @click="emit('close')">
          <Icon name="x" :size="18" />
        </button>
      </div>

      <div ref="bodyRef" class="search-body">
        <div v-if="!lastParams && !isSearching" class="search-state">
          <Icon name="search" :size="40" class="search-state-icon" />
          <h3>{{ t('messageSearch.title') }}</h3>
          <p>{{ t('messageSearch.intro') }}</p>
          <div v-if="recentSearches.length" class="search-recent">
            <div class="search-recent-header">
              <span>{{ t('messageSearch.recent') }}</span>
              <button type="button" class="search-link" @click="clearRecentSearches">{{ t('messageSearch.clearRecent') }}</button>
            </div>
            <button
              v-for="entry in recentSearches.slice(0, 5)"
              :key="entry"
              type="button"
              class="search-recent-item"
              @click="loadRecent(entry)"
            >
              <Icon name="clock" :size="14" />
              <span>{{ entry }}</span>
            </button>
          </div>
          <p class="search-e2ee"><Icon name="lock" :size="12" />{{ t('messageSearch.encryptedNote') }}</p>
        </div>

        <template v-else>
          <div class="search-toolbar">
            <span class="search-count" aria-live="polite">
              <template v-if="isSearching && total === null">{{ t('messageSearch.searching') }}</template>
              <template v-else-if="totalCapped">{{ t('messageSearch.resultsCapped', { count: formatCount(SEARCH_TOTAL_CAP) }) }}</template>
              <template v-else>{{ t('messageSearch.results', { count: formatCount(total ?? 0) }, total ?? 0) }}</template>
            </span>
            <div class="search-sort" role="group" :aria-label="t('messageSearch.sort')">
              <button
                v-for="option in sortOptions"
                :key="option.value"
                type="button"
                class="search-sort-option"
                :class="{ active: sort === option.value }"
                :disabled="option.value === 'relevance' && !lastParams?.p_query"
                :aria-pressed="sort === option.value"
                @click="changeSort(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
          <p class="search-e2ee"><Icon name="lock" :size="12" />{{ t('messageSearch.encryptedNote') }}</p>

          <section v-if="localResults.length" class="search-group">
            <h4 class="search-group-title"><Icon name="lock" :size="12" />{{ t('messageSearch.onThisDevice') }}</h4>
            <SearchResultItem
              v-for="r in localResults"
              :key="`local-${r.message.id}`"
              :message="r.message"
              :server-id="serverId"
              @open="openMessage"
            />
          </section>

          <div v-if="isSearching && results.length === 0" class="search-state">
            <LoadingSpinner :size="32" />
            <p>{{ t('messageSearch.searching') }}</p>
          </div>

          <EmptyState
            v-else-if="error"
            tone="error"
            icon="alert-circle"
            :title="t('messageSearch.error')"
            :description="error"
            :action-label="t('common.retry')"
            @action="runSearch(page)"
          />

          <EmptyState
            v-else-if="results.length === 0"
            icon="search"
            :title="t('messageSearch.empty')"
            :description="t('messageSearch.emptyHint')"
          />

          <div v-else class="search-results" :class="{ stale: isSearching }">
            <section v-for="group in groups" :key="group.key" class="search-group">
              <h4 v-if="group.label" class="search-group-title">
                <Icon :name="group.icon" :size="12" />{{ group.label }}
              </h4>
              <SearchResultItem
                v-for="message in group.messages"
                :key="message.id"
                :message="message"
                :server-id="serverId"
                @open="openMessage"
              />
            </section>

            <nav v-if="pageCount > 1" class="search-pager" :aria-label="t('messageSearch.pages')">
              <button type="button" class="search-page" :disabled="page === 0 || isSearching" @click="runSearch(page - 1)">
                <Icon name="chevron-left" :size="14" />{{ t('messageSearch.previous') }}
              </button>
              <button
                v-for="n in pageWindow"
                :key="n"
                type="button"
                class="search-page"
                :class="{ active: n === page }"
                :aria-current="n === page ? 'page' : undefined"
                :disabled="isSearching"
                @click="runSearch(n)"
              >
                {{ n + 1 }}
              </button>
              <button type="button" class="search-page" :disabled="page >= pageCount - 1 || isSearching" @click="runSearch(page + 1)">
                {{ t('messageSearch.next') }}<Icon name="chevron-right" :size="14" />
              </button>
            </nav>
          </div>
        </template>
      </div>
    </div>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import SearchQueryInput from '@/components/search/SearchQueryInput.vue'
import SearchResultItem from '@/components/search/SearchResultItem.vue'
import { useMessageSearch } from '@/composables/useMessageSearch'
import { useLocalMessageSearch } from '@/composables/useLocalMessageSearch'
import { SEARCH_TOTAL_CAP } from '@/services/SearchService'
import { userDataService } from '@/services/userDataService'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useProfileStore } from '@/stores/useProfile'
import {
  highlightTerms,
  messageMatchesParams,
  parseSearchQuery,
  resolveToken,
  type SearchChannel,
  type SearchMember,
  type SearchSort,
} from '@/utils/searchQuery'
import type { Message } from '@/types'

const props = defineProps<{
  show: boolean
  serverId?: string | null
  conversationId?: string | null
  /** Listed first among in: suggestions. */
  currentChannelId?: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'message-click', message: Message, searchText?: string): void
}>()

const { t, locale } = useI18n()
const serverChannelStore = useServerChannelStore()
const chatStore = useChatStore()
const dmStore = useDMStore()
const profileStore = useProfileStore()

const scope = computed(() => props.conversationId
  ? { conversationId: props.conversationId }
  : { serverId: props.serverId ?? undefined })

const {
  tokens, text, sort, page, results, total, totalCapped, pageCount, isSearching, error, lastParams,
  recentSearches, execute, reset, clearRecentSearches,
} = useMessageSearch(scope)

const queryInputRef = ref<InstanceType<typeof SearchQueryInput>>()
const bodyRef = ref<HTMLElement>()

const placeholder = computed(() => props.conversationId
  ? t('messageSearch.placeholderDm')
  : t('messageSearch.placeholderServer'))

const sortOptions = computed<Array<{ value: SearchSort; label: string }>>(() => [
  { value: 'newest', label: t('messageSearch.newest') },
  { value: 'oldest', label: t('messageSearch.oldest') },
  { value: 'relevance', label: t('messageSearch.relevant') },
])

// ---------------------------------------------------------------------------
// Entities for autocomplete and for resolving typed filters
// ---------------------------------------------------------------------------

const channels = computed<SearchChannel[]>(() => {
  if (props.conversationId) return []
  const list = serverChannelStore.channels
    .filter(c => c.type === 0 && (!props.serverId || !c.server_id || c.server_id === props.serverId))
    .map(c => ({ id: c.id, name: c.name }))
  const current = list.findIndex(c => c.id === props.currentChannelId)
  return current > 0 ? [list[current], ...list.slice(0, current), ...list.slice(current + 1)] : list
})

const members = ref<SearchMember[]>([])

const loadMembers = () => {
  const out = new Map<string, SearchMember>()
  const add = (id?: string | null, username?: string | null, displayName?: string | null) => {
    if (!id || !username || out.has(id)) return
    out.set(id, { id, username, displayName: displayName || undefined })
  }
  if (props.conversationId) {
    const me = profileStore.profile
    add(me?.id, me?.username, me?.display_name)
    const conv = dmStore.conversations.find(c => c.id === props.conversationId)
    add(conv?.other_user?.id, conv?.other_user?.username, conv?.other_user?.display_name)
    for (const p of conv?.participants ?? []) add(p.id, p.username, p.display_name)
  } else {
    const inServer = props.serverId ? userDataService.getUsersInContext(props.serverId) : []
    for (const u of inServer.length ? inServer : userDataService.getAllUsers()) {
      add(u.id, u.username, u.displayName)
    }
  }
  members.value = [...out.values()]
}

// ---------------------------------------------------------------------------
// Encrypted messages already decrypted on this device
// ---------------------------------------------------------------------------

const localCandidates = computed<Message[]>(() => {
  const params = lastParams.value
  if (!params) return []
  const loaded = props.conversationId
    ? (dmStore.currentConversationId === props.conversationId ? dmStore.currentDMMessages : [])
    : chatStore.messages
  return loaded.filter(m => m.encrypted && m.decrypted && messageMatchesParams(m, params))
})

const localSearch = useLocalMessageSearch(localCandidates)
const localResults = computed(() => (page.value === 0 ? localSearch.searchResults.value : []))

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const channelName = (id: string): string =>
  serverChannelStore.channels.find(c => c.id === id)?.name ?? t('messageSearch.unknownChannel')

/** Consecutive results from one channel share a heading; a conversation needs none. */
const groups = computed(() => {
  const out: Array<{ key: string; label: string | null; icon: string; messages: Message[] }> = []
  for (const message of results.value) {
    const where = message.thread_id ? `thread:${message.thread_id}` : message.channel_id ?? message.conversation_id ?? ''
    const last = out[out.length - 1]
    if (last && last.key.startsWith(`${where}|`)) {
      last.messages.push(message)
      continue
    }
    const label = props.conversationId || !message.channel_id
      ? null
      : message.thread_id
        ? t('messageSearch.threadIn', { channel: channelName(message.channel_id) })
        : channelName(message.channel_id)
    out.push({ key: `${where}|${out.length}`, label, icon: message.thread_id ? 'thread' : 'hash', messages: [message] })
  }
  return out
})

const pageWindow = computed(() => {
  const count = pageCount.value
  const first = Math.max(0, Math.min(page.value - 2, count - 5))
  return Array.from({ length: Math.min(5, count) }, (_, i) => first + i)
})

const formatCount = (n: number) => new Intl.NumberFormat(locale.value).format(n)

const runSearch = async (targetPage: number) => {
  tokens.value = tokens.value.map(tok => resolveToken(tok, { members: members.value, channels: channels.value }))
  await execute(targetPage)
  if (targetPage === 0) localSearch.setQuery(text.value)
  bodyRef.value?.scrollTo({ top: 0 })
}

const changeSort = (value: SearchSort) => {
  if (sort.value === value) return
  sort.value = value
  void runSearch(0)
}

const loadRecent = (entry: string) => {
  const parsed = parseSearchQuery(entry)
  tokens.value = parsed.tokens
  text.value = parsed.text
  void runSearch(0)
}

const openMessage = (message: Message) => {
  emit('message-click', message, highlightTerms(text.value) || undefined)
  emit('close')
}

const focusInput = () => {
  nextTick(() => queryInputRef.value?.focus())
}

watch(() => props.show, (open) => {
  if (open) {
    loadMembers()
  } else {
    reset()
    localSearch.clearSearch()
  }
}, { immediate: true })

watch(() => [props.serverId, props.conversationId], () => {
  if (!props.show) return
  loadMembers()
  if (lastParams.value) void runSearch(0)
})
</script>

<style scoped>
.search-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.search-bar {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-secondary);
}

.search-bar-input {
  flex: 1;
  min-width: 0;
}

.search-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--bg-hover);
  color: var(--text-secondary);
  cursor: pointer;
}

.search-close:hover {
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.search-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-3) var(--space-4) var(--space-4);
}

.search-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.search-count {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.search-sort {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
}

.search-sort-option {
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.search-sort-option.active {
  background: var(--background-modifier-selected);
  color: var(--text-primary);
}

.search-sort-option:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.search-e2ee {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: var(--space-2) 0 var(--space-3);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

.search-results {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  transition: opacity var(--transition-fast);
}

.search-results.stale {
  opacity: 0.6;
}

.search-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.search-group-title {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.search-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-12) var(--space-4);
  text-align: center;
  color: var(--text-secondary);
}

.search-state h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}

.search-state p {
  margin: 0;
  max-width: 420px;
  font-size: var(--font-size-sm);
}

.search-state-icon {
  color: var(--text-muted);
}

.search-recent {
  width: 100%;
  max-width: 420px;
  margin-top: var(--space-4);
  text-align: left;
}

.search-recent-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-2);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.search-recent-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.search-recent-item span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.search-recent-item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.search-link {
  border: none;
  background: none;
  color: var(--harmony-primary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.search-button {
  padding: var(--space-2) var(--space-4);
  border: none;
  border-radius: var(--radius-md);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.search-button:hover {
  background: var(--harmony-primary-hover);
}

.search-pager {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding-top: var(--space-2);
}

.search-page {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 32px;
  justify-content: center;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  background: var(--background-secondary);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.search-page.active {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.search-page:disabled:not(.active) {
  opacity: 0.5;
  cursor: not-allowed;
}

.search-page:hover:not(:disabled):not(.active) {
  color: var(--text-primary);
  border-color: var(--border-hover);
}
</style>

<style>
.message-search-modal.modal-container {
  height: min(90vh, 900px);
}

.message-search-modal .modal-body {
  max-height: none;
  overflow: hidden;
}
</style>
