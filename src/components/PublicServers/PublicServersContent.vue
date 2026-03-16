<template>
  <div class="public-servers-content">
    <!-- Loading State with Skeletons -->
    <div v-if="isLoading" class="loading-state">
      <div class="loading-header">
        <div class="loading-spinner">
          <svg viewBox="0 0 24 24" class="spinner">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="31.416" stroke-dashoffset="31.416">
              <animate attributeName="stroke-dasharray" dur="2s" values="0 31.416;15.708 15.708;0 31.416" repeatCount="indefinite"/>
              <animate attributeName="stroke-dashoffset" dur="2s" values="0;-15.708;-31.416" repeatCount="indefinite"/>
            </circle>
          </svg>
        </div>
        <div class="loading-text">
          <h3 class="loading-title">{{ $t('server.loadingCommunities') }}</h3>
          <p class="loading-description">{{ $t('server.findingBestServers') }}</p>
        </div>
      </div>
      
      <!-- Skeleton Cards -->
      <ServerCardSkeleton :count="6" />
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="error-state">
      <div class="error-icon">
        <svg viewBox="0 0 24 24" class="error-svg">
          <path d="M12,2L13.09,8.26L22,9L17,14L18.18,21L12,17.77L5.82,21L7,14L2,9L8.91,8.26L12,2Z" fill="currentColor"/>
        </svg>
      </div>
      <h3 class="error-title">{{ $t('server.failedToLoadCommunities') }}</h3>
      <p class="error-description">{{ error }}</p>
      <button @click="$emit('refresh')" class="refresh-btn">
        <svg viewBox="0 0 24 24" class="refresh-icon">
          <path d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z" fill="currentColor"/>
        </svg>
        {{ $t('server.tryAgain') }}
      </button>
    </div>

    <!-- Empty State -->
    <div v-else-if="isEmpty" class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" class="empty-svg">
          <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
        </svg>
      </div>
      <h3 class="empty-title">{{ $t('server.noServersAvailable') }}</h3>
      <p class="empty-description">
        {{ $t('server.noServersDescription') }}
      </p>
      <button @click="$emit('refresh')" class="refresh-btn">
        <svg viewBox="0 0 24 24" class="refresh-icon">
          <path d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z" fill="currentColor"/>
        </svg>
        {{ $t('common.retry') }}
      </button>
    </div>

    <!-- Empty Search State -->
    <div v-else-if="isEmptySearch && searchQuery" class="empty-state">
      <div class="empty-icon search-empty">
        <svg viewBox="0 0 24 24" class="empty-svg">
          <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
        </svg>
      </div>
      <h3 class="empty-title">{{ $t('server.noResultsFor', { query: searchQuery }) }}</h3>
      <p class="empty-description">
        {{ $t('server.tryAdjustingSearch') }}
      </p>
    </div>

    <!-- Featured Servers Section -->
    <div v-else-if="featuredServers.length > 0 && !searchQuery" class="featured-section">
      <div class="section-header">
        <h3 class="section-title">{{ $t('server.featuredCommunities') }}</h3>
        <div class="section-decoration"></div>
      </div>
      
      <div class="featured-grid">
        <ServerCard
          v-for="server in featuredServers"
          :key="`featured-${server.id}`"
          :server="server"
          :is-joined="joinedServerIds.has(server.id)"
          :is-loading="loadingServerIds.has(server.id)"
          @join="$emit('joinServer', $event)"
          @leave="$emit('leaveServer', $event)"
          @view-owner-profile="$emit('viewOwnerProfile', $event)"
          class="featured-card"
        />
      </div>
    </div>

    <!-- Main Server Grid -->
    <div v-if="servers.length > 0" class="servers-section">
      <div v-if="!searchQuery && featuredServers.length > 0" class="section-header">
        <h3 class="section-title">{{ $t('server.allCommunities') }}</h3>
        <div class="section-decoration"></div>
      </div>
      
      <div class="server-grid">
        <ServerCard
          v-for="server in displayedServers"
          :key="server.id"
          :server="server"
          :is-joined="joinedServerIds.has(server.id)"
          :is-loading="loadingServerIds.has(server.id)"
          @join="$emit('joinServer', $event)"
          @leave="$emit('leaveServer', $event)"
          @view-owner-profile="$emit('viewOwnerProfile', $event)"
        />
      </div>
      
      <!-- Load More Button (if needed for large lists) -->
      <div v-if="hasMoreServers" class="load-more-section">
        <button @click="loadMore" class="load-more-btn">
          {{ $t('server.loadMoreCommunities') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ServerCard from '@/components/common/ServerCard.vue'
import ServerCardSkeleton from '@/components/common/ServerCardSkeleton.vue'
import type { PublicServerWithStats } from '@/stores/usePublicServers'

interface Props {
  servers: PublicServerWithStats[]
  featuredServers: PublicServerWithStats[]
  isLoading: boolean
  isEmpty: boolean
  isEmptySearch: boolean
  searchQuery: string
  joinedServerIds: Set<string>
  loadingServerIds: Set<string>
  error?: string | null
}

interface Emits {
  (e: 'joinServer', serverId: string): void
  (e: 'leaveServer', serverId: string): void
  (e: 'viewOwnerProfile', userId: string): void
  (e: 'refresh'): void
}

const props = defineProps<Props>()
defineEmits<Emits>()

const displayLimit = ref(20)

const displayedServers = computed(() => {
  // Filter out featured servers from the main list if not searching
  let filtered = props.servers
  if (!props.searchQuery && props.featuredServers.length > 0) {
    const featuredIds = new Set(props.featuredServers.map(s => s.id))
    filtered = props.servers.filter(s => !featuredIds.has(s.id))
  }
  
  return filtered.slice(0, displayLimit.value)
})

const hasMoreServers = computed(() => {
  const totalDisplayable = props.searchQuery || props.featuredServers.length === 0 
    ? props.servers.length 
    : props.servers.length - props.featuredServers.length
  
  return displayLimit.value < totalDisplayable
})

const loadMore = () => {
  displayLimit.value += 20
}
</script>

<style scoped>
.public-servers-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px 32px;
  display: flex;
  flex-direction: column;
  gap: 32px;
}

/* Loading State */
.loading-state {
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.loading-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px 20px;
  text-align: center;
}

.loading-spinner {
  width: 48px;
  height: 48px;
  color: rgba(14, 165, 233, 0.8);
  margin-bottom: 24px;
}

.spinner {
  width: 100%;
  height: 100%;
}

.loading-text {
  max-width: 300px;
}

.loading-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.loading-description {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.7);
  margin: 0;
}

/* Empty States */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
}

.empty-icon {
  width: 64px;
  height: 64px;
  background: rgba(14, 165, 233, 0.1);
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 24px;
  color: rgba(14, 165, 233, 0.6);
}

.empty-icon.search-empty {
  background: rgba(237, 66, 69, 0.1);
  color: rgba(237, 66, 69, 0.6);
}

.empty-svg {
  width: 32px;
  height: 32px;
}

.empty-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px 0;
}

.empty-description {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.7);
  margin: 0 0 24px 0;
  max-width: 400px;
  line-height: 1.5;
}

.refresh-btn {
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
  border: none;
  border-radius: 8px;
  padding: 12px 24px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.2s ease;
}

.refresh-btn:hover {
  background: linear-gradient(135deg, #0284C7, #5b6ecd);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.4);
}

.refresh-icon {
  width: 16px;
  height: 16px;
}

/* Section Headers */
.section-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.section-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}

.section-decoration {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, rgba(14, 165, 233, 0.5), transparent);
}

/* Featured Grid */
.featured-section {
  margin-bottom: 16px;
}

.featured-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.featured-card {
  /* featured styling handled by server-card--featured class */
}

/* Main Server Grid */
.servers-section {
  flex: 1;
}

.server-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

/* Load More */
.load-more-section {
  display: flex;
  justify-content: center;
  margin-top: 32px;
}

.load-more-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  padding: 12px 24px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.load-more-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.3);
  color: var(--text-primary);
}

.error-svg {
  width: 32px;
  height: 32px;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .public-servers-content {
    padding: 20px 24px;
    gap: 24px;
  }
  
  .featured-grid,
  .server-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  
  .section-header {
    margin-bottom: 16px;
  }
  
  .section-title {
    font-size: 16px;
  }
}

@media (max-width: 480px) {
  .public-servers-content {
    padding: 16px 20px;
  }
  
  .empty-state,
  .loading-state {
    padding: 40px 20px;
  }
  
  .empty-icon {
    width: 48px;
    height: 48px;
  }
  
  .empty-svg {
    width: 24px;
    height: 24px;
  }
}
</style>
