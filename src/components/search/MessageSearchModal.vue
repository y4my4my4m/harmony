<template>
  <Teleport to="body">
    <div v-if="show" class="search-modal-overlay" @click="handleOverlayClick" @keydown.esc="handleClose">
      <div class="search-modal" @click.stop>
        <!-- Header -->
        <div class="search-modal-header">
          <h2 class="search-modal-title">{{ $t('message.search') }}</h2>
          <button @click="handleClose" class="close-btn" title="Close (Esc)">
            <Icon name="x" />
          </button>
        </div>

        <!-- Search Input -->
        <div class="search-input-container">
          <div class="search-input-wrapper">
            <Icon name="search" class="search-icon" />
            <input
              ref="searchInputRef"
              v-model="filters.query"
              type="text"
              :placeholder="$t('message.searchMessages')"
              class="search-input"
              @input="handleSearchInput"
              @keydown.enter="executeSearch(true)"
              @keydown.escape="handleClose"
            />
            <button
              v-if="filters.query"
              @click="clearQuery"
              class="clear-btn"
              title="Clear search"
            >
              <Icon name="x" :size="16" />
            </button>
          </div>
        </div>

        <!-- Filters Panel -->
        <div class="filters-panel" v-if="showFilters">
          <div class="filters-header">
            <span class="filters-title">{{ $t('message.filters') }}</span>
            <button
              v-if="hasActiveFilters"
              @click="clearAllFilters"
              class="clear-filters-btn"
            >
              {{ $t('message.clearAll') }}
            </button>
          </div>

          <div class="filters-grid">
            <!-- Channel Filter -->
            <div class="filter-group">
              <label class="filter-label">{{ $t('message.channel') }}</label>
              <input
                v-model="channelFilterInput"
                type="text"
                :placeholder="$t('message.channelPlaceholder')"
                class="filter-input"
                @input="handleChannelFilterInput"
              />
              <div v-if="channelSuggestions.length > 0" class="filter-suggestions">
                <button
                  v-for="channel in channelSuggestions"
                  :key="channel.id"
                  @click="selectChannel(channel.id)"
                  class="filter-suggestion-item"
                >
                  {{ channel.name }}
                </button>
              </div>
            </div>

            <!-- User Filter -->
            <div class="filter-group">
              <label class="filter-label">{{ $t('message.fromUser') }}</label>
              <input
                v-model="userFilterInput"
                type="text"
                :placeholder="$t('message.usernamePlaceholder')"
                class="filter-input"
                @input="handleUserFilterInput"
              />
              <div v-if="userSuggestions.length > 0" class="filter-suggestions">
                <button
                  v-for="user in userSuggestions"
                  :key="user.id"
                  @click="selectUser(user.id)"
                  class="filter-suggestion-item"
                >
                  {{ getUserDisplayName(user.id).value || user.username }}
                </button>
              </div>
            </div>

            <!-- Date Range -->
            <div class="filter-group">
              <label class="filter-label">{{ $t('message.dateRange') }}</label>
              <div class="date-range-inputs">
                <input
                  v-model="fromDateInput"
                  type="date"
                  class="filter-input date-input"
                  :placeholder="$t('message.from')"
                />
                <input
                  v-model="toDateInput"
                  type="date"
                  class="filter-input date-input"
                  :placeholder="$t('message.to')"
                />
              </div>
            </div>

            <!-- Media/URL Filters -->
            <div class="filter-group filter-checkboxes">
              <label class="filter-checkbox">
                <input
                  type="checkbox"
                  v-model="filters.hasMedia"
                  @change="handleFilterChange"
                />
                <span>{{ $t('message.hasMedia') }}</span>
              </label>
              <label class="filter-checkbox">
                <input
                  type="checkbox"
                  v-model="filters.hasUrl"
                  @change="handleFilterChange"
                />
                <span>{{ $t('message.hasUrl') }}</span>
              </label>
            </div>
          </div>

          <!-- Active Filter Chips -->
          <div v-if="hasActiveFilters" class="active-filters">
            <div
              v-for="(filter, key) in activeFilterChips"
              :key="key"
              class="filter-chip"
            >
              <span class="filter-chip-label">{{ filter.label }}:</span>
              <span class="filter-chip-value">{{ filter.value }}</span>
              <button @click="() => handleClearFilter(key)" class="filter-chip-remove">
                <Icon name="x" :size="12" />
              </button>
            </div>
          </div>
        </div>

        <!-- Toggle Filters Button -->
        <button
          @click="showFilters = !showFilters"
          class="toggle-filters-btn"
          :class="{ active: showFilters }"
        >
          <Icon name="filter" />
          <span>Filters</span>
          <span v-if="hasActiveFilters" class="filter-badge">{{ activeFilterCount }}</span>
        </button>

        <!-- Search Results -->
        <div class="search-results-container">
          <!-- Loading State -->
          <div v-if="isSearching && searchResults.length === 0" class="loading-state">
            <LoadingSpinner :size="32" />
            <p>{{ $t('message.searchingMessages') }}</p>
          </div>

          <!-- Error State -->
          <div v-else-if="error" class="error-state">
            <Icon name="alert-circle" :size="48" />
            <h3>{{ $t('message.searchError') }}</h3>
            <p>{{ error }}</p>
            <button @click="executeSearch(true)" class="retry-btn">{{ $t('common.retry') }}</button>
          </div>

          <!-- Empty State -->
          <div v-else-if="!isSearching && searchResults.length === 0 && (filters.query || hasActiveFilters)" class="empty-state">
            <Icon name="search" :size="48" />
            <h3>{{ $t('message.noResults') }}</h3>
            <p>{{ $t('message.tryAdjustSearch') }}</p>
          </div>

          <!-- Initial State -->
          <div v-else-if="!filters.query && !hasActiveFilters" class="initial-state">
            <Icon name="search" :size="48" />
            <h3>{{ $t('message.search') }}</h3>
            <p>{{ $t('message.searchAcrossMessages') }}</p>
            
            <!-- E2EE Notice -->
            <div class="encryption-notice">
              <Icon name="lock" :size="14" />
              <span>{{ $t('message.encryptedSearchNotice', 'End-to-end encrypted messages cannot be searched server-side. Use in-conversation search for encrypted DMs.') }}</span>
            </div>
            
            <!-- Recent Searches -->
            <div v-if="recentSearches.length > 0" class="recent-searches">
              <h4>{{ $t('message.recentSearches') }}</h4>
              <div class="recent-list">
                <button
                  v-for="(search, index) in recentSearches.slice(0, 5)"
                  :key="index"
                  @click="setQuery(search)"
                  class="recent-item"
                >
                  <Icon name="clock" :size="14" />
                  <span>{{ search }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Results List -->
          <div v-else class="results-list">
            <div
              v-for="message in searchResults"
              :key="message.id"
              class="search-result-item"
              @click="handleMessageClick(message)"
            >
              <div class="result-header">
                <Avatar
                  :src="getUserAvatarUrl(message.user_id).value"
                  :alt="getUserDisplayName(message.user_id).value || 'User'"
                  size="sm"
                />
                <div class="result-meta">
                  <span class="result-username" :style="{ color: getUserColor(message.user_id).value || undefined }">
                    {{ getUserDisplayName(message.user_id).value || 'Unknown User' }}
                  </span>
                  <span class="result-channel" v-if="message.channel_id">
                    in {{ getChannelName(message.channel_id) }}
                  </span>
                  <span class="result-time">{{ formatTime(message.created_at) }}</span>
                </div>
              </div>
              <div class="result-content">
                <UnifiedMessageContent
                  :content="message.content"
                  :message-id="message.id"
                  :embed-payloads="message.metadata?.embeds"
                />
              </div>
            </div>

            <!-- Load More Button -->
            <div v-if="canLoadMore" class="load-more-container">
              <button @click="loadMore" class="load-more-btn" :disabled="isSearching">
                <Icon v-if="isSearching" name="loader" class="spinning" />
                <span>{{ isSearching ? 'Loading...' : 'Load More' }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessageSearch } from '@/composables/useMessageSearch'
import { useUserData } from '@/composables/useUserData'
import { useServerChannelStore } from '@/stores/useServerChannel'
import type { Message, Channel } from '@/types'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'

const { t } = useI18n()

interface Props {
  show: boolean
  initialQuery?: string
  initialChannelId?: string
  initialConversationId?: string
  initialServerId?: string
}

interface Emits {
  (e: 'close'): void
  (e: 'message-click', message: Message, searchQuery?: string): void
}

const props = withDefaults(defineProps<Props>(), {
  show: false,
  initialQuery: '',
  initialChannelId: undefined,
  initialConversationId: undefined,
  initialServerId: undefined
})

const emit = defineEmits<Emits>()

// Composables
const {
  isSearching,
  searchResults,
  error,
  filters,
  recentSearches,
  hasActiveFilters,
  canLoadMore,
  setQuery,
  setFilter,
  clearFilter,
  clearAllFilters,
  executeSearch,
  loadMore
} = useMessageSearch()

const {
  getUserAvatarUrl,
  getUserDisplayName,
  getUserColor
} = useUserData()

const serverChannelStore = useServerChannelStore()

// Component state
const searchInputRef = ref<HTMLInputElement>()
const showFilters = ref(false)
const channelFilterInput = ref('')
const userFilterInput = ref('')
const fromDateInput = ref('')
const toDateInput = ref('')
const channelSuggestions = ref<Channel[]>([])
const userSuggestions = ref<any[]>([])

// Initialize filters from props (only when modal opens, not on mount)
watch(() => props.show, (newVal, oldVal) => {
  if (newVal && !oldVal) {
    // Modal is being opened (was false, now true)
    // Only set initial values if provided
    if (props.initialQuery) {
      setQuery(props.initialQuery)
    }
    if (props.initialChannelId) {
      setFilter('channelId', props.initialChannelId)
    }
    if (props.initialConversationId) {
      setFilter('conversationId', props.initialConversationId)
    }
    if (props.initialServerId) {
      setFilter('serverId', props.initialServerId)
    }
    
    // Focus input when modal opens
    nextTick(() => {
      searchInputRef.value?.focus()
    })
  } else if (!newVal && oldVal) {
    // Modal is being closed (was true, now false)
    // Reset when closing
    clearAllFilters()
    showFilters.value = false
  }
})

// Watch date inputs
watch([fromDateInput, toDateInput], ([from, to]) => {
  setFilter('fromDate', from ? new Date(from) : null)
  setFilter('toDate', to ? new Date(to) : null)
})

// Computed
const activeFilterChips = computed(() => {
  const chips: Record<string, { label: string; value: string }> = {}
  
  if (filters.value.channelId) {
    const channelId = Array.isArray(filters.value.channelId) 
      ? filters.value.channelId[0] 
      : filters.value.channelId
    chips.channelId = {
      label: t('message.channel'),
      value: getChannelName(channelId) || channelId
    }
  }
  
  if (filters.value.userId) {
    chips.userId = {
      label: t('message.user'),
      value: getUserDisplayName(filters.value.userId).value || filters.value.userId
    }
  }
  
  if (filters.value.hasMedia) {
    chips.hasMedia = { label: t('message.hasMedia'), value: t('message.yes') }
  }
  
  if (filters.value.hasUrl) {
    chips.hasUrl = { label: t('message.hasUrl'), value: t('message.yes') }
  }
  
  if (filters.value.fromDate) {
    chips.fromDate = {
      label: t('message.from'),
      value: new Date(filters.value.fromDate).toLocaleDateString()
    }
  }
  
  if (filters.value.toDate) {
    chips.toDate = {
      label: t('message.to'),
      value: new Date(filters.value.toDate).toLocaleDateString()
    }
  }
  
  return chips
})

const activeFilterCount = computed(() => {
  return Object.keys(activeFilterChips.value).length
})

// Methods
const handleClose = () => {
  emit('close')
}

const handleOverlayClick = () => {
  handleClose()
}

const handleSearchInput = () => {
  // Debounced search is handled by composable
}

const clearQuery = () => {
  setQuery('')
  searchInputRef.value?.focus()
}

const handleFilterChange = () => {
  executeSearch(true)
}

const handleChannelFilterInput = () => {
  const query = channelFilterInput.value.toLowerCase()
  if (!query) {
    channelSuggestions.value = []
    return
  }
  
  // Get channels from current server or all accessible channels
  const channels = serverChannelStore.channels || []
  channelSuggestions.value = channels
    .filter(ch => ch.name.toLowerCase().includes(query))
    .slice(0, 5)
}

const handleUserFilterInput = async () => {
  const query = userFilterInput.value.toLowerCase()
  if (!query) {
    userSuggestions.value = []
    return
  }
  
  // TODO: Implement user search
  // For now, use users from current context
  userSuggestions.value = []
}

const selectChannel = (channelId: string) => {
  setFilter('channelId', channelId)
  channelFilterInput.value = ''
  channelSuggestions.value = []
  executeSearch(true)
}

const selectUser = (userId: string) => {
  setFilter('userId', userId)
  userFilterInput.value = ''
  userSuggestions.value = []
  executeSearch(true)
}

const getChannelName = (channelId: string): string => {
  const channel = serverChannelStore.channels.find(c => c.id === channelId)
  return channel?.name || 'Unknown Channel'
}

const formatTime = (date: Date | string): string => {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    hour: 'numeric',
    minute: '2-digit'
  })
}

const handleClearFilter = (key: string) => {
  clearFilter(key as keyof typeof filters.value)
}

const handleMessageClick = (message: Message) => {
  emit('message-click', message, filters.value.query)
  handleClose()
}

onMounted(() => {
  if (props.show) {
    nextTick(() => {
      searchInputRef.value?.focus()
    })
  }
})
</script>

<style scoped>
.search-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
}

.search-modal {
  width: 90%;
  max-width: 800px;
  max-height: 90vh;
  background: var(--background-quaternary);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-modal);
}

.search-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-primary);
}

.search-modal-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--border-hover);
  color: var(--text-primary);
}

.search-input-container {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-primary);
}

.search-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 12px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 12px 40px 12px 40px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 16px;
  outline: none;
  transition: border-color 0.2s;
}

.search-input:focus {
  border-color: var(--harmony-primary);
}

.clear-btn {
  position: absolute;
  right: 8px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s;
}

.clear-btn:hover {
  color: var(--text-primary);
  background: var(--border-hover);
}

.filters-panel {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-primary);
  background: var(--background-tertiary);
}

.filters-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.filters-title {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 14px;
}

.clear-filters-btn {
  background: transparent;
  border: none;
  color: var(--harmony-primary);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.2s;
}

.clear-filters-btn:hover {
  background: var(--harmony-primary-light);
}

.filters-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.filter-group.filter-checkboxes {
  grid-column: 1 / -1;
  flex-direction: row;
  gap: 16px;
}

.filter-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.filter-input {
  padding: 8px 12px;
  background: var(--background-quaternary);
  border: 1px solid var(--border-primary);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}

.filter-input:focus {
  border-color: var(--harmony-primary);
}

.date-range-inputs {
  display: flex;
  gap: 8px;
}

.date-input {
  flex: 1;
}

.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 14px;
}

.filter-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.filter-suggestions {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--background-quaternary);
  border: 1px solid var(--border-primary);
  border-radius: 4px;
  margin-top: 4px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 1000;
}

.filter-suggestion-item {
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: none;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition: background 0.2s;
}

.filter-suggestion-item:hover {
  background: var(--border-hover);
}

.active-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.filter-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--harmony-primary);
  border-radius: 12px;
  font-size: 12px;
}

.filter-chip-label {
  font-weight: 600;
  color: var(--text-primary);
}

.filter-chip-value {
  color: rgba(255, 255, 255, 0.9);
}

.filter-chip-remove {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  padding: 2px;
  border-radius: 2px;
  transition: all 0.2s;
}

.filter-chip-remove:hover {
  background: rgba(255, 255, 255, 0.2);
  color: var(--text-primary);
}

.toggle-filters-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: transparent;
  border: none;
  border-top: 1px solid var(--border-primary);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.toggle-filters-btn:hover {
  background: var(--border-secondary);
  color: var(--text-primary);
}

.toggle-filters-btn.active {
  background: var(--background-tertiary);
  color: var(--harmony-primary);
}

.filter-badge {
  background: var(--harmony-primary);
  color: var(--text-primary);
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}

.search-results-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}

.loading-state,
.error-state,
.empty-state,
.initial-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
  color: var(--text-muted);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-state h3,
.empty-state h3,
.initial-state h3 {
  margin: 16px 0 8px;
  color: var(--text-primary);
  font-size: 18px;
}

.error-state p,
.empty-state p,
.initial-state p {
  margin: 0 0 16px;
  color: var(--text-secondary);
}

.retry-btn {
  padding: 8px 16px;
  background: var(--harmony-primary);
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 14px;
  transition: background 0.2s;
}

.retry-btn:hover {
  background: var(--harmony-primary-hover);
}

.encryption-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(250, 168, 26, 0.1);
  border: 1px solid rgba(250, 168, 26, 0.3);
  border-radius: 4px;
  color: var(--status-away);
  font-size: 12px;
  text-align: left;
  max-width: 400px;
  margin-top: 16px;
}

.encryption-notice span {
  line-height: 1.4;
}

.recent-searches {
  margin-top: 24px;
  width: 100%;
  max-width: 400px;
}

.recent-searches h4 {
  margin: 0 0 12px;
  color: var(--text-secondary);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.recent-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--background-tertiary);
  border: none;
  border-radius: 4px;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  transition: all 0.2s;
}

.recent-item:hover {
  background: var(--background-quaternary);
  color: var(--text-primary);
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.search-result-item {
  padding: 12px;
  background: var(--background-tertiary);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.search-result-item:hover {
  background: var(--background-quaternary);
}

.result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.result-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.result-username {
  font-weight: 600;
  color: var(--text-primary);
}

.result-channel {
  color: var(--text-muted);
}

.result-time {
  color: var(--text-muted);
  font-size: 12px;
}

.result-content {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}

.load-more-container {
  display: flex;
  justify-content: center;
  padding: 16px 0;
}

.load-more-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--harmony-primary);
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 14px;
  transition: background 0.2s;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
}

.load-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}
</style>

