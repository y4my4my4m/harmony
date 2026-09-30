<template>
  <div class="public-servers-content">
    <div
      v-if="isLoading"
      class="loading-state"
      role="status"
      aria-busy="true"
      :aria-label="$t('server.loadingCommunities')"
    >
      <ServerCardSkeleton :count="6" />
    </div>

    <div v-else-if="error" class="empty-state" role="alert">
      <div class="empty-icon empty-icon--error">
        <Icon name="alert-triangle" :size="28" />
      </div>
      <h3 class="empty-title">{{ $t('server.failedToLoadCommunities') }}</h3>
      <p class="empty-description">{{ error }}</p>
      <button type="button" class="btn btn-secondary" @click="$emit('refresh')">
        <Icon name="refresh" :size="16" />
        {{ $t('server.tryAgain') }}
      </button>
    </div>

    <div v-else-if="isEmpty" class="empty-state">
      <div class="empty-icon">
        <Icon name="compass" :size="28" />
      </div>
      <h3 class="empty-title">{{ $t('server.noServersAvailable') }}</h3>
      <p class="empty-description">
        {{ $t('server.noServersDescription') }}
      </p>
      <button type="button" class="btn btn-secondary" @click="$emit('refresh')">
        <Icon name="refresh" :size="16" />
        {{ $t('common.retry') }}
      </button>
    </div>

    <div v-else-if="isEmptyResults" class="empty-state">
      <div class="empty-icon">
        <Icon name="search" :size="28" />
      </div>
      <h3 class="empty-title">
        {{ searchQuery ? $t('server.noResultsFor', { query: searchQuery }) : $t('server.noCommunitiesInCategory') }}
      </h3>
      <p class="empty-description">
        {{ $t('server.tryAdjustingSearch') }}
      </p>
    </div>

    <template v-else>
      <section v-if="featuredServers.length > 0" class="servers-section">
        <h3 class="section-title">{{ $t('server.featuredCommunities') }}</h3>
        <div class="server-grid">
          <ServerCard
            v-for="server in featuredServers"
            :key="`featured-${server.id}`"
            :server="server"
            :is-joined="joinedServerIds.has(server.id)"
            :is-loading="loadingServerIds.has(server.id)"
            @join="$emit('joinServer', $event)"
            @open="$emit('openServer', $event)"
            @view-owner-profile="$emit('viewOwnerProfile', $event)"
          />
        </div>
      </section>

      <section v-if="displayedServers.length > 0" class="servers-section">
        <h3 v-if="featuredServers.length > 0" class="section-title">{{ $t('server.allCommunities') }}</h3>
        <div class="server-grid">
          <ServerCard
            v-for="server in displayedServers"
            :key="server.id"
            :server="server"
            :is-joined="joinedServerIds.has(server.id)"
            :is-loading="loadingServerIds.has(server.id)"
            @join="$emit('joinServer', $event)"
            @open="$emit('openServer', $event)"
            @view-owner-profile="$emit('viewOwnerProfile', $event)"
          />
        </div>

        <div v-if="hasMoreServers" class="load-more-section">
          <button type="button" class="btn btn-secondary" @click="loadMore">
            {{ $t('server.loadMoreCommunities') }}
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import ServerCard from '@/components/common/ServerCard.vue'
import ServerCardSkeleton from '@/components/common/ServerCardSkeleton.vue'
import type { PublicServerWithStats } from '@/stores/usePublicServers'

interface Props {
  servers: PublicServerWithStats[]
  featuredServers: PublicServerWithStats[]
  isLoading: boolean
  isEmpty: boolean
  isEmptyResults: boolean
  searchQuery: string
  joinedServerIds: Set<string>
  loadingServerIds: Set<string>
  error?: string | null
}

interface Emits {
  (e: 'joinServer', serverId: string): void
  (e: 'openServer', serverId: string): void
  (e: 'viewOwnerProfile', userId: string): void
  (e: 'refresh'): void
}

const props = defineProps<Props>()
defineEmits<Emits>()

const PAGE_SIZE = 20
const displayLimit = ref(PAGE_SIZE)

const listedServers = computed(() => {
  if (props.featuredServers.length === 0) return props.servers
  const featuredIds = new Set(props.featuredServers.map(s => s.id))
  return props.servers.filter(s => !featuredIds.has(s.id))
})

const displayedServers = computed(() => listedServers.value.slice(0, displayLimit.value))

const hasMoreServers = computed(() => displayLimit.value < listedServers.value.length)

const loadMore = () => {
  displayLimit.value += PAGE_SIZE
}

watch(() => props.servers, () => {
  displayLimit.value = PAGE_SIZE
})
</script>

<style scoped src="./discoveryButtons.css"></style>

<style scoped>
.public-servers-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
}

.empty-icon {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-xl);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--space-5);
}

.empty-icon--error {
  color: var(--error);
}

.empty-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 var(--space-2);
}

.empty-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0 0 var(--space-6);
  max-width: 400px;
  line-height: 1.5;
}

.servers-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.section-title {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  margin: 0;
}

.server-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-3);
}

.load-more-section {
  display: flex;
  justify-content: center;
  margin-top: var(--space-4);
}

@media (max-width: 768px) {
  .public-servers-content {
    padding: var(--space-4);
    gap: var(--space-6);
  }

  .server-grid {
    grid-template-columns: 1fr;
  }
}
</style>
