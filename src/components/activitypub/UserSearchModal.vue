<!-- UserSearchModal - Search for federated users -->
<template>
  <Teleport to="body">
    <div class="modal-overlay" @click="handleOverlayClick">
      <div class="search-modal" @click.stop>
        <div class="modal-header">
          <h2 class="modal-title">Search Users</h2>
          <button @click="$emit('close')" class="close-btn" title="Close">
            <Icon name="x" />
          </button>
        </div>

        <div class="search-container">
          <div class="search-input-wrapper">
            <Icon name="search" class="search-icon" />
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="text"
              placeholder="Search for users (@username@domain or display name)"
              class="search-input"
              @input="handleSearchInput"
              @keydown.enter="performSearch"
              @keydown.escape="$emit('close')"
            />
            <button
              v-if="searchQuery"
              @click="clearSearch"
              class="clear-btn"
              title="Clear search"
            >
              <Icon name="x" :size="16" />
            </button>
          </div>

          <div class="search-filters">
            <button
              v-for="filter in searchFilters"
              :key="filter.id"
              @click="setActiveFilter(filter.id)"
              :class="['filter-btn', { active: activeFilter === filter.id }]"
            >
              <Icon :name="filter.icon" />
              <span>{{ filter.label }}</span>
            </button>
          </div>
        </div>

        <div class="search-results">
          <div v-if="isSearching" class="loading-state">
            <LoadingSpinner :size="32" />
            <p>{{ $t('activitypub.searchingFediverse') }}</p>
          </div>

          <div v-else-if="!isSearching && searchResults.length === 0 && searchQuery" class="empty-state">
            <Icon name="users" :size="48" />
            <h3>{{ $t('activitypub.noUsersFound') }}</h3>
            <p>{{ $t('activitypub.tryDifferentSearch') }}</p>
            <div class="search-tips">
              <h4>{{ $t('activitypub.searchTips') }}</h4>
              <ul>
                <li>{{ $t('activitypub.searchTipsExactMatch') }}</li>
                <li>{{ $t('activitypub.searchTipsPartial') }}</li>
                <li>{{ $t('activitypub.searchTipsDomain') }}</li>
              </ul>
            </div>
          </div>

          <div v-else-if="!searchQuery" class="initial-state">
            <Icon name="search" :size="48" />
            <h3>Search for Users</h3>
            <p>Find users from this instance or across the fediverse.</p>

            <div v-if="recentSearches.length > 0" class="recent-searches">
              <h4>Recent Searches</h4>
              <div class="recent-list">
                <button
                  v-for="search in recentSearches"
                  :key="search.id"
                  @click="selectRecentSearch(search)"
                  class="recent-item"
                >
                  <img 
                    :src="search.avatar_url || '/default_avatar.webp'" 
                    :alt="search.display_name"
                    class="recent-avatar"
                  />
                  <div class="recent-info">
                    <div class="recent-name"><DisplayName :userId="search.id" :fallback="search.display_name || search.username" /></div>
                    <div class="recent-handle">{{ search.handle }}</div>
                  </div>
                </button>
              </div>
            </div>

            <div v-if="suggestedUsers.length > 0" class="suggested-users">
              <h4>Suggested Users</h4>
              <div class="suggested-list">
                <UserCard
                  v-for="user in suggestedUsers"
                  :key="user.id"
                  :user="user"
                  :is-compact="true"
                  :show-follow-btn="true"
                  @user-click="selectUser"
                />
              </div>
            </div>
          </div>

          <div v-else class="results-list">
            <UserCard
              v-for="user in filteredResults"
              :key="user.id"
              :user="user"
              :is-compact="true"
              :show-follow-btn="true"
              @user-click="selectUser"
            />
          </div>
        </div>

        <div class="search-actions">
          <button
            v-if="hasMoreResults"
            @click="loadMoreResults"
            :disabled="isLoadingMore"
            class="load-more-btn"
          >
            <Icon v-if="isLoadingMore" name="loader" class="spinning" />
            <span>{{ isLoadingMore ? 'Loading...' : 'Load More' }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { debug } from '@/utils/debug'
import { activityPubService } from '@/services/activityPubService';
import type { FederatedUser } from '@/types';
import Icon from '@/components/common/Icon.vue';
import UserCard from './UserCard.vue';
import DisplayName from '@/components/DisplayName.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

const emit = defineEmits<{
  'close': [];
  'user-selected': [user: FederatedUser];
}>();

const searchInputRef = ref<HTMLInputElement>();

const searchQuery = ref('');
const searchResults = ref<FederatedUser[]>([]);
const isSearching = ref(false);
const isLoadingMore = ref(false);
const hasMoreResults = ref(false);
const activeFilter = ref('all');
const recentSearches = ref<FederatedUser[]>([]);
const suggestedUsers = ref<FederatedUser[]>([]);

const searchFilters = [
  { id: 'all', label: 'All', icon: 'users' },
  { id: 'local', label: 'Local', icon: 'home' },
  { id: 'remote', label: 'Federated', icon: 'globe' }
];

const filteredResults = computed(() => {
  if (activeFilter.value === 'all') return searchResults.value;
  if (activeFilter.value === 'local') return searchResults.value.filter(u => u.is_local);
  if (activeFilter.value === 'remote') return searchResults.value.filter(u => !u.is_local);
  return searchResults.value;
});

const handleOverlayClick = () => {
  emit('close');
};

const clearSearch = () => {
  searchQuery.value = '';
  searchResults.value = [];
  hasMoreResults.value = false;
};

const setActiveFilter = (filterId: string) => {
  activeFilter.value = filterId;
};

const handleSearchInput = () => {
  // Debounce search
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    if (searchQuery.value.trim().length >= 2) {
      performSearch();
    } else {
      searchResults.value = [];
      hasMoreResults.value = false;
    }
  }, 300) as unknown as number;
};

let searchTimeout: number;

// guard against slow older search response overwriting a newer one
let searchSeq = 0;

const performSearch = async () => {
  const query = searchQuery.value.trim();
  if (!query || query.length < 2) return;

  const seq = ++searchSeq;
  isSearching.value = true;
  searchResults.value = [];
  hasMoreResults.value = false;

  try {
    const handleMatch = query.match(/^@?([^@]+)@([^@]+)$/);

    if (handleMatch) {
      // Direct handle lookup
      const [, username, domain] = handleMatch;
      try {
        const user = await activityPubService.getUserByHandle(`${username}@${domain}`);
        if (seq !== searchSeq) return; // stale response
        if (user) {
          searchResults.value = [user];
          addToRecentSearches(user);
        }
      } catch (error) {
        debug.error('Failed to resolve user:', error);
        // Fallback to regular search
        await performRegularSearch(query, seq);
      }
    } else {
      await performRegularSearch(query, seq);
    }
  } catch (error) {
    debug.error('Search failed:', error);
  } finally {
    if (seq === searchSeq) {
      isSearching.value = false;
    }
  }
};

const performRegularSearch = async (query: string, seq: number) => {
  try {
    const results = await activityPubService.searchUsers(query, 20);
    if (seq !== searchSeq) return; // stale response
    searchResults.value = results;
    hasMoreResults.value = results.length >= 20;
  } catch (error) {
    debug.error('Regular search failed:', error);
    if (seq === searchSeq) searchResults.value = [];
  }
};

const loadMoreResults = async () => {
  if (!hasMoreResults.value || isLoadingMore.value) return;

  isLoadingMore.value = true;
  try {
    // TODO: Implement pagination
    await new Promise(resolve => setTimeout(resolve, 1000));
    hasMoreResults.value = false;
  } catch (error) {
    debug.error('Failed to load more results:', error);
  } finally {
    isLoadingMore.value = false;
  }
};

const selectUser = (user: FederatedUser) => {
  addToRecentSearches(user);
  emit('user-selected', user);
  emit('close');
};

const selectRecentSearch = (user: FederatedUser) => {
  searchQuery.value = user.handle;
  searchResults.value = [user];
};

const addToRecentSearches = (user: FederatedUser) => {
  recentSearches.value = recentSearches.value.filter(u => u.id !== user.id);
  
  recentSearches.value.unshift(user);

  recentSearches.value = recentSearches.value.slice(0, 5);
  
  try {
    localStorage.setItem('fediverse_recent_searches', JSON.stringify(recentSearches.value));
  } catch (error) {
    debug.warn('Failed to save recent searches:', error);
  }
};

const loadRecentSearches = () => {
  try {
    const saved = localStorage.getItem('fediverse_recent_searches');
    if (saved) {
      recentSearches.value = JSON.parse(saved);
    }
  } catch (error) {
    debug.warn('Failed to load recent searches:', error);
  }
};

const loadSuggestedUsers = async () => {
  try {
    // TODO: Load from API
    suggestedUsers.value = [];
  } catch (error) {
    debug.error('Failed to load suggested users:', error);
  }
};

onMounted(async () => {
  await nextTick();
  searchInputRef.value?.focus();
  loadRecentSearches();
  loadSuggestedUsers();
});

onUnmounted(() => {
  if (searchTimeout) clearTimeout(searchTimeout);
});
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

.search-modal {
  width: 100%;
  max-width: 600px;
  height: 80vh;
  background: var(--background-quaternary);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.modal-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.search-container {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.search-input-wrapper {
  position: relative;
  margin-bottom: 1rem;
}

.search-icon {
  position: absolute;
  left: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-tertiary);
  pointer-events: none;
}

.search-input {
  width: 100%;
  background: var(--background-tertiary);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 0.75rem 2.5rem 0.75rem 2.5rem;
  color: var(--text-primary);
  font-size: 1rem;
  transition: border-color 0.2s;
}

.search-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.search-input::placeholder {
  color: var(--text-tertiary);
}

.clear-btn {
  position: absolute;
  right: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: 4px;
  padding: 0.25rem;
  transition: all 0.2s;
}

.clear-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.search-filters {
  display: flex;
  gap: 0.5rem;
}

.filter-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: var(--text-tertiary);
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.2s;
}

.filter-btn:hover {
  border-color: rgba(255, 255, 255, 0.16);
  color: var(--text-primary);
}

.filter-btn.active {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}

.search-results {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.5rem;
}

.loading-state,
.empty-state,
.initial-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-tertiary);
  padding: 2rem;
}

.empty-state h3,
.initial-state h3 {
  color: var(--text-primary);
  margin: 1rem 0 0.5rem;
  font-size: 1.25rem;
}

.search-tips {
  background: var(--background-tertiary);
  border-radius: 8px;
  padding: 1rem;
  margin-top: 1rem;
  text-align: left;
  max-width: 300px;
}

.search-tips h4 {
  color: var(--text-primary);
  margin: 0 0 0.5rem;
  font-size: 0.875rem;
}

.search-tips ul {
  margin: 0;
  padding-left: 1rem;
  list-style: disc;
}

.search-tips li {
  font-size: 0.75rem;
  margin-bottom: 0.25rem;
}

.recent-searches,
.suggested-users {
  margin-top: 1.5rem;
  width: 100%;
}

.recent-searches h4,
.suggested-users h4 {
  color: var(--text-primary);
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
  text-align: left;
}

.recent-list,
.suggested-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: none;
  border: none;
  color: var(--text-primary);
  padding: 0.75rem;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  transition: background 0.2s;
  width: 100%;
}

.recent-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.recent-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}

.recent-info {
  flex: 1;
}

.recent-name {
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.recent-handle {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.search-actions {
  padding: 1rem 1.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.load-more-btn {
  width: 100%;
  background: var(--background-tertiary);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: var(--text-primary);
  padding: 0.75rem;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.load-more-btn:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .modal-overlay {
    padding: 0;
  }
  
  .search-modal {
    height: 100vh;
    border-radius: 0;
  }
  
  .search-container,
  .search-results,
  .search-actions {
    padding-left: 1rem;
    padding-right: 1rem;
  }
  
  .search-filters {
    flex-wrap: wrap;
  }
}
</style>
