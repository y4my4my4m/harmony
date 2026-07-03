<template>
<!-- Featured Communities -->
<div class="admin-module featured-module">
  <div class="module-header">
    <Icon name="star" :size="20" />
    <h2>Featured Communities</h2>
    <button @click="loadFeaturedServers" class="action-btn" :disabled="loadingStates.featuredServers">
      <Icon v-if="loadingStates.featuredServers" name="loader" :size="16" class="spin" />
      <Icon v-else name="refresh-cw" :size="16" />
      Refresh
    </button>
  </div>
  <p class="module-hint">Pin public servers to the top of the community discovery page. Featured servers appear first.</p>
  <div v-if="loadingStates.featuredServers" class="loading-state">
    <LoadingSpinner :size="20" />
    <span>Loading communities...</span>
  </div>
  <div v-else class="featured-servers-list">
    <div
      v-for="server in featuredServersList"
      :key="server.id"
      class="featured-server-item"
      :class="{ featured: server.is_featured }"
    >
      <div class="server-icon-wrap">
        <img
          :src="getServerIconUrl(server.icon)"
          :alt="server.name"
          class="server-icon"
        />
        <span v-if="server.is_featured" class="featured-badge">
          <Icon name="star" :size="12" />
        </span>
      </div>
      <div class="server-details">
        <div class="server-name">{{ server.name }}</div>
        <div class="server-meta">
          {{ server.member_count ?? 0 }} members
          <span v-if="server.is_featured" class="featured-order">#{{ server.featured_order }}</span>
        </div>
      </div>
      <button
        @click="toggleFeaturedServer(server)"
        class="action-btn-sm"
        :class="server.is_featured ? 'unpin-btn' : 'pin-btn'"
        :disabled="featuredServerToggling.has(server.id)"
        :title="server.is_featured ? 'Remove from featured' : 'Add to featured'"
      >
        <Icon v-if="featuredServerToggling.has(server.id)" name="loader" :size="14" class="spin" />
        <Icon v-else :name="server.is_featured ? 'x' : 'star'" :size="14" />
        {{ server.is_featured ? 'Unpin' : 'Pin' }}
      </button>
    </div>
    <div v-if="featuredServersList.length === 0 && !loadingStates.featuredServers" class="empty-state">
      No public communities yet. Create public servers to feature them.
    </div>
  </div>
</div>



<!-- Configuration -->
<InstanceConfig />

<!-- Funding Management -->
<FundingSupporters />

<!-- Performance Monitoring -->
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { adminService } from '@/services/AdminService'
import { usePublicServersStore } from '@/stores/usePublicServers'
import { getServerIconUrl } from '@/utils/serverUtils'


const toast = useToast()

const loadingStates = ref({ featuredServers: false })


// Featured communities
const featuredServersList = ref<Array<{
  id: string;
  name: string;
  description?: string;
  icon?: string;
  is_featured: boolean;
  featured_order: number;
  member_count?: number;
}>>([])
const featuredServerToggling = ref<Set<string>>(new Set())

const loadFeaturedServers = async () => {
  loadingStates.value.featuredServers = true
  try {
    featuredServersList.value = await adminService.getPublicServersForAdmin()
  } catch (error) {
    debug.error('Failed to load featured servers:', error)
    featuredServersList.value = []
  } finally {
    loadingStates.value.featuredServers = false
  }
}

const toggleFeaturedServer = async (server: { id: string; name: string; is_featured: boolean; featured_order: number }) => {
  if (featuredServerToggling.value.has(server.id)) return
  featuredServerToggling.value = new Set([...featuredServerToggling.value, server.id])
  try {
    const newFeatured = !server.is_featured
    const order = newFeatured
      ? Math.max(0, ...featuredServersList.value.filter(s => s.is_featured).map(s => s.featured_order), -1) + 1
      : 0
    await adminService.setServerFeatured(server.id, newFeatured, order)
    toast.success(newFeatured ? `Featured "${server.name}"` : `Removed "${server.name}" from featured`)
    await loadFeaturedServers()
    usePublicServersStore().fetchPublicServers(true)
  } catch (error: any) {
    debug.error('Failed to toggle featured:', error)
    toast.error(error.message || 'Failed to update featured status')
  } finally {
    featuredServerToggling.value = new Set([...featuredServerToggling.value].filter(id => id !== server.id))
  }
}


onMounted(() => { void loadFeaturedServers() })
</script>

<style scoped>








.spin {
  animation: spin 1s linear infinite;
}









/* Announcements module */
.module-hint {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 16px 24px;
  margin: 0;
  text-align: center;
  line-height: 1.5;
}









/* Featured Communities Module */
.featured-module .module-hint { margin: 0 24px 16px; font-size: 13px; color: var(--text-secondary); }








.featured-servers-list { display: flex; flex-direction: column; gap: 8px; padding: 0 24px 24px; }








.featured-server-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
  transition: all 0.2s ease;
}








.featured-server-item:hover { border-color: var(--accent-color); }








.featured-server-item.featured {
  border-color: rgba(255, 193, 7, 0.5);
  background: rgba(255, 193, 7, 0.05);
}








.server-icon-wrap {
  position: relative;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
}








.server-icon {
  width: 100%;
  height: 100%;
  border-radius: 8px;
  object-fit: cover;
}








.featured-badge {
  position: absolute;
  bottom: -4px;
  right: -4px;
  color: var(--accent-color);
  background: var(--background-secondary);
  border-radius: 50%;
  padding: 2px;
}








.server-details { flex: 1; min-width: 0; }








.server-details .server-name { font-weight: 600; color: var(--text-primary); }








.server-details .server-meta { font-size: 13px; color: var(--text-secondary); }








.featured-order { margin-left: 8px; opacity: 0.8; }








.featured-server-item .action-btn-sm.pin-btn { color: var(--accent-color); }








.featured-server-item .action-btn-sm.unpin-btn { color: var(--text-secondary); }








.featured-server-item .action-btn-sm { display: flex; align-items: center; gap: 6px; }









.server-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
}









.server-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}









.server-name {
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}









.server-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}
</style>

<style scoped src="./adminShared.css"></style>
