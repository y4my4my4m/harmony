<template>
<div class="admin-module federation-module">
  <div class="module-header">
    <Icon name="federation" :size="20" />
    <h2>Federation management</h2>
    <div class="module-actions">
      <button @click="handleAddInstance" class="primary-btn">
        <Icon name="plus" :size="16" />
        Add instance
      </button>
      <button @click="refreshFederationData" class="action-btn" :disabled="loadingStates.federationStats">
        <Icon name="refresh-cw" :size="16" />
        Refresh
      </button>
    </div>
  </div>

  <!-- Federation Stats -->
  <div class="federation-stats">
    <div class="stat-card">
      <div class="stat-value">{{ formatNumber(instanceStats?.total_instances) }}</div>
      <div class="stat-label">Total instances</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{{ formatNumber(instanceStats?.active_instances) }}</div>
      <div class="stat-label">Active (7 days)</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{{ formatNumber(instanceStats?.trusted_instances) }}</div>
      <div class="stat-label">Trusted</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{{ formatNumber(instanceStats?.blocked_instances) }}</div>
      <div class="stat-label">Blocked</div>
    </div>
  </div>

  <!-- Endpoint Health Stats -->
  <div class="federation-section" v-if="federationStats">
    <div class="section-header">
      <h3>Endpoint health</h3>
      <div class="health-indicator" :class="getEndpointHealthClass(federationStats.endpoint_health)">
        {{ federationStats.endpoint_health.success_rate }}% success rate
      </div>
    </div>
    <div class="federation-stats">
      <div class="stat-card">
        <div class="stat-value">{{ formatNumber(federationStats.endpoint_health.total_endpoints) }}</div>
        <div class="stat-label">Total endpoints</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" :class="{ 'error-text': federationStats.endpoint_health.dead_endpoints > 0 }">
          {{ formatNumber(federationStats.endpoint_health.dead_endpoints) }}
        </div>
        <div class="stat-label">Dead endpoints</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ formatNumber(federationStats.endpoint_health.healthy_endpoints) }}</div>
        <div class="stat-label">Healthy</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ formatNumber(federationStats.endpoint_health.endpoints_with_failures) }}</div>
        <div class="stat-label">With failures</div>
      </div>
    </div>
    <div class="endpoint-details" v-if="federationStats.endpoint_health.dead_endpoints > 0">
      <div class="warning-banner">
        <Icon name="alert-triangle" :size="16" />
        <span>{{ federationStats.endpoint_health.dead_endpoints }} endpoint(s) marked as dead and removed from follows</span>
        <button
          class="danger-btn purge-btn"
          :disabled="loadingStates.purgingDead"
          @click="purgeDeadEndpoints"
        >
          <Icon v-if="!loadingStates.purgingDead" name="trash" :size="14" />
          <span v-if="loadingStates.purgingDead" class="spinner-small"></span>
          Purge all
        </button>
      </div>
      <div class="dead-endpoints-list" v-if="deadEndpointsList.length > 0">
        <div
          v-for="ep in deadEndpointsList"
          :key="ep.id"
          class="dead-endpoint-row"
        >
          <div class="dead-endpoint-info">
            <div class="dead-endpoint-url" :title="ep.endpoint_url">{{ ep.endpoint_url }}</div>
            <div class="dead-endpoint-meta">
              <span class="meta-tag domain">{{ ep.domain }}</span>
              <span class="meta-tag" v-if="ep.last_http_status">HTTP {{ ep.last_http_status }}</span>
              <span class="meta-tag failures">{{ ep.total_failures }} failures</span>
              <span class="meta-tag" v-if="ep.last_failure_at">Last fail: {{ formatTimeAgo(ep.last_failure_at) }}</span>
            </div>
            <div class="dead-endpoint-error" v-if="ep.last_error_message" :title="ep.last_error_message">
              {{ ep.last_error_message }}
            </div>
          </div>
          <button
            class="purge-single-btn"
            :disabled="purgingEndpointIds.has(ep.id)"
            @click="purgeSingleEndpoint(ep)"
            title="Remove this endpoint"
          >
            <span v-if="purgingEndpointIds.has(ep.id)" class="spinner-small"></span>
            <Icon v-else name="trash" :size="14" />
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Federation Maintenance -->
  <div class="federation-section">
    <div class="section-header-row">
      <h3>Federation maintenance</h3>
      <button @click="refreshKeyConsistency" class="action-btn" :disabled="loadingStates.keyConsistency">
        <Icon name="refresh-cw" :size="16" />
      </button>
    </div>
    
    <!-- Key Consistency Report -->
    <div class="maintenance-status" v-if="keyConsistency">
      <div class="status-indicator" :class="keyConsistency.status">
        <Icon :name="keyConsistency.status === 'ok' ? 'check-circle' : 'alert-triangle'" :size="16" />
        <span v-if="keyConsistency.status === 'ok'">All local users have valid key pairs</span>
        <span v-else>
          {{ keyConsistency.users_missing_keys }} user(s) missing keys, 
          {{ keyConsistency.users_with_inconsistent_keys }} with inconsistent state
        </span>
      </div>
    </div>
    
    <!-- Maintenance Actions -->
    <div class="maintenance-actions">
      <div class="maintenance-card">
        <div class="maintenance-info">
          <h4>Key generation sweep</h4>
          <p>Generate missing RSA keys for local users who don't have them</p>
        </div>
        <button 
          @click="runKeyGenerationSweep" 
          class="action-btn primary"
          :disabled="loadingStates.keySweep"
        >
          <Icon v-if="loadingStates.keySweep" name="loader" :size="16" class="spin" />
          <Icon v-else name="key" :size="16" />
          Run sweep
        </button>
      </div>
      
      <div class="maintenance-card">
        <div class="maintenance-info">
          <h4>Orphan cleanup</h4>
          <p>Fix users with inconsistent key states (public without private or vice versa)</p>
        </div>
        <button 
          @click="runOrphanCleanup" 
          class="action-btn"
          :disabled="loadingStates.orphanCleanup"
        >
          <Icon v-if="loadingStates.orphanCleanup" name="loader" :size="16" class="spin" />
          <Icon v-else name="trash-2" :size="16" />
          Run cleanup
        </button>
      </div>
    </div>
    
    <!-- Scheduled Jobs Info -->
    <div class="scheduled-info">
      <Icon name="clock" :size="14" />
      <span>Maintenance jobs run automatically: key sweep at 03:00 UTC, orphan cleanup at 04:00 UTC</span>
    </div>
  </div>

  <!-- Instance Management -->
  <div class="federation-section">
    <div class="section-controls">
      <h3>Instance directory</h3>
      <div class="filter-controls">
        <select v-model="instanceFilter" @change="loadFederatedInstances" class="cyber-select">
          <option value="all">All instances</option>
          <option value="active">Active</option>
          <option value="trusted">Trusted</option>
          <option value="blocked">Blocked</option>
        </select>
        <input
          v-model="instanceSearch"
          @input="debouncedSearchInstances"
          placeholder="Search instances…"
          class="cyber-input"
        />
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="loadingStates.instances" class="loading-state">
      <LoadingSpinner :size="20" />
      <span>Loading instances…</span>
    </div>

    <!-- Instance List -->
    <div v-else class="instance-list">
      <div
        v-for="instance in federatedInstances"
        :key="instance.id"
        class="instance-item"
        :class="{ 
          'blocked': instance.is_blocked, 
          'trusted': instance.is_trusted,
          'inactive': isInstanceInactive(instance)
        }"
      >
        <div class="instance-main">
          <div class="instance-info">
            <div class="instance-domain">
              <strong>{{ instance.domain }}</strong>
              <div class="instance-badges">
                <span v-if="instance.is_trusted" class="badge trusted">Trusted</span>
                <span v-if="instance.is_blocked" class="badge blocked">Blocked</span>
                <span v-if="instance.limited_at" class="badge limited" title="Accounts from this domain are silenced">Limited</span>
                <span v-if="isInstanceInactive(instance)" class="badge inactive">Inactive</span>
              </div>
            </div>
            <div class="instance-details">
              <span v-if="instance.software" class="detail-item">
                {{ instance.software }} {{ instance.version }}
              </span>
              <span class="detail-item">
                {{ formatNumber(instance.user_count) }} users
              </span>
              <span class="detail-item">
                {{ formatNumber(instance.status_count) }} posts
              </span>
              <span class="detail-item">
                Last seen: {{ formatRelativeTime(instance.last_seen_at) }}
              </span>
            </div>
            <div v-if="instance.description" class="instance-description">
              {{ instance.description }}
            </div>
          </div>
          <div class="instance-actions">
            <button 
              @click="refreshInstance(instance.id)" 
              class="action-btn-sm"
              title="Refresh instance info"
            >
              <Icon name="refresh-cw" :size="14" />
            </button>
            <button 
              v-if="!instance.is_trusted && !instance.is_blocked"
              @click="toggleInstanceTrust(instance.id, true)" 
              class="action-btn-sm"
              title="Mark as trusted"
            >
              <Icon name="check" :size="14" />
            </button>
            <button 
              v-if="instance.is_trusted"
              @click="toggleInstanceTrust(instance.id, false)" 
              class="action-btn-sm trusted"
              title="Remove trust"
            >
              <Icon name="check" :size="14" />
            </button>
            <button
              v-if="!instance.is_blocked && !instance.limited_at"
              @click="toggleInstanceLimit(instance.domain, true)"
              class="action-btn-sm"
              title="Limit: silence this domain's accounts"
            >
              <Icon name="volume-x" :size="14" />
            </button>
            <button
              v-if="instance.limited_at"
              @click="toggleInstanceLimit(instance.domain, false)"
              class="action-btn-sm"
              title="Lift the limit"
            >
              <Icon name="volume-2" :size="14" />
            </button>
            <button 
              v-if="!instance.is_blocked"
              @click="toggleInstanceBlock(instance.id, true)" 
              class="danger-btn-sm"
              title="Block instance"
            >
              <Icon name="shield" :size="14" />
            </button>
            <button 
              v-if="instance.is_blocked"
              @click="toggleInstanceBlock(instance.id, false)" 
              class="action-btn-sm"
              title="Unblock instance"
            >
              <Icon name="shield-off" :size="14" />
            </button>
            <button 
              @click="deleteInstance(instance.id)" 
              class="danger-btn-sm"
              title="Delete instance"
            >
              <Icon name="trash" :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="instancePagination.total > instancePagination.limit" class="pagination">
      <button 
        @click="loadPreviousInstances" 
        :disabled="instancePagination.offset === 0"
        class="pagination-btn"
      >
        Previous
      </button>
      <span class="pagination-info">
        {{ instancePagination.offset + 1 }}-{{ Math.min(instancePagination.offset + instancePagination.limit, instancePagination.total) }} 
        of {{ instancePagination.total }}
      </span>
      <button 
        @click="loadNextInstances" 
        :disabled="instancePagination.offset + instancePagination.limit >= instancePagination.total"
        class="pagination-btn"
      >
        Next
      </button>
    </div>
  </div>

  <!-- Discovery Section -->
  <div class="federation-section">
    <h3>Instance discovery</h3>
    <div class="discovery-tabs">
      <button 
        @click="discoveryTab = 'discovered'" 
        :class="{ active: discoveryTab === 'discovered' }"
        class="tab-btn"
      >
        From interactions
      </button>
      <button 
        @click="discoveryTab = 'search'" 
        :class="{ active: discoveryTab === 'search' }"
        class="tab-btn"
      >
        Search & Add
      </button>
    </div>

    <!-- Discovered Instances -->
    <div v-if="discoveryTab === 'discovered'" class="discovery-content">
      <EmptyState
        v-if="discoveredInstances.length === 0"
        icon="search"
        :title="$t('empty.admin.discoveredInstances.title')"
        :action-label="$t('empty.admin.discoveredInstances.action')"
        @action="loadDiscoveredInstances"
      />
      <div v-else class="discovered-list">
        <div
          v-for="discovered in discoveredInstances"
          :key="discovered.domain"
          class="discovered-item"
        >
          <div class="discovered-info">
            <strong>{{ discovered.domain }}</strong>
            <span class="interaction-count">{{ discovered.interaction_count }} interactions</span>
          </div>
          <button 
            @click="addDiscoveredInstance(discovered.domain)" 
            class="primary-btn-sm"
          >
            <Icon name="plus" :size="14" />
            Add
          </button>
        </div>
      </div>
    </div>

    <!-- Search & Add -->
    <div v-if="discoveryTab === 'search'" class="discovery-content">
      <div class="search-form">
        <input
          v-model="newInstanceDomain"
          @keyup.enter="discoverInstance"
          placeholder="Enter domain (e.g., mastodon.social)"
          class="cyber-input"
        />
        <button 
          @click="discoverInstance" 
          :disabled="!newInstanceDomain || loadingStates.discovering"
          class="primary-btn"
        >
          <Icon v-if="loadingStates.discovering" name="loader" :size="16" class="spinning" />
          <Icon v-else name="search" :size="16" />
          {{ loadingStates.discovering ? 'Discovering…' : 'Discover' }}
        </button>
      </div>

      <!-- Discovery Result -->
      <div v-if="discoveryResult" class="discovery-result">
        <div class="result-header">
          <h4>{{ discoveryResult.domain }}</h4>
          <div class="result-badges">
            <span v-if="discoveryResult.federation_enabled" class="badge success">Federation enabled</span>
            <span v-if="discoveryResult.api_available" class="badge info">API available</span>
          </div>
        </div>
        <div class="result-details">
          <div v-if="discoveryResult.software" class="detail-row">
            <strong>Software:</strong> {{ discoveryResult.software }} {{ discoveryResult.version }}
          </div>
          <div v-if="discoveryResult.description" class="detail-row">
            <strong>Description:</strong> {{ discoveryResult.description }}
          </div>
          <div class="detail-row">
            <strong>Users:</strong> {{ formatNumber(discoveryResult.user_count) }}
          </div>
          <div class="detail-row">
            <strong>Posts:</strong> {{ formatNumber(discoveryResult.status_count) }}
          </div>
          <div v-if="discoveryResult.admin_contact" class="detail-row">
            <strong>Admin:</strong> {{ discoveryResult.admin_contact }}
          </div>
        </div>
        <div class="result-actions">
          <label class="checkbox-label">
            <input type="checkbox" v-model="addAsTrusted" />
            Add as trusted instance
          </label>
          <button @click="addInstanceFromDiscovery" class="primary-btn">
            <Icon name="plus" :size="16" />
            Add instance
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { adminService, type FederatedInstance, type InstanceStats, type InstanceSearchResult, type FederationStats, type DeadEndpoint } from '@/services/AdminService'
import { formatNumber, formatTimeAgo, formatRelativeTime } from './adminFormat'
import { useToast } from 'vue-toastification'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

const authStore = useAuthStore()
const toast = useToast()
const { confirm } = useConfirmDialog()

// Federation management data
const instanceStats = ref<InstanceStats>({
  total_instances: 0,
  blocked_instances: 0,
  trusted_instances: 0,
  active_instances: 0,
  recently_discovered: 0
})

const federationStats = ref<FederationStats | null>(null)
const deadEndpointsList = ref<DeadEndpoint[]>([])
const purgingEndpointIds = ref<Set<string>>(new Set())
const federatedInstances = ref<FederatedInstance[]>([])
const discoveredInstances = ref<{ domain: string; user_count: number; interaction_count: number }[]>([])
const discoveryResult = ref<InstanceSearchResult | null>(null)
// eslint-disable-next-line unused-imports/no-unused-vars
const showAddInstanceModal = ref(false)
const instanceFilter = ref<'all' | 'blocked' | 'trusted' | 'active'>('all')
const instanceSearch = ref('')
const discoveryTab = ref('discovered')
const newInstanceDomain = ref('')
const addAsTrusted = ref(false)

const loadingStates = ref({
  federationStats: false,
  instances: false,
  discovering: false,
  keyConsistency: false,
  keySweep: false,
  orphanCleanup: false,
  purgingDead: false,
})

const keyConsistency = ref<{
  users_missing_keys: number;
  users_with_inconsistent_keys: number;
  inconsistent_users: Array<{
    user_id: string;
    username: string;
    has_public_key: boolean;
    has_private_key: boolean;
  }>;
  status: 'ok' | 'needs_attention';
} | null>(null)

const instancePagination = ref({
  offset: 0,
  limit: 20,
  total: 0
})

// Federation management methods
const refreshFederationData = async () => {
  loadingStates.value.federationStats = true
  try {
    await Promise.all([
      loadInstanceStats(),
      loadFederatedInstances(),
      loadFederationStats()
    ])
  } catch (error) {
    debug.error('Failed to refresh federation data:', error)
  } finally {
    loadingStates.value.federationStats = false
  }
}

const loadFederationStats = async () => {
  try {
    const [stats, deadEndpoints] = await Promise.all([
      adminService.getFederationStats(),
      adminService.getDeadEndpoints()
    ])
    federationStats.value = stats
    deadEndpointsList.value = deadEndpoints
  } catch (error) {
    debug.error('Failed to load federation stats:', error)
  }
}

const getEndpointHealthClass = (health: FederationStats['endpoint_health']) => {
  if (health.dead_endpoints > 0) return 'error'
  if (health.success_rate < 80) return 'warning'
  return 'healthy'
}

const purgeDeadEndpoints = async () => {
  const ok = await confirm({
    title: 'Purge dead endpoints',
    message: `Permanently remove all ${federationStats.value?.endpoint_health.dead_endpoints} dead endpoint(s) and their failed deliveries? This cannot be undone.`,
    confirmButtonText: 'Purge',
    dangerAction: true,
  })
  if (!ok) return
  loadingStates.value.purgingDead = true
  try {
    const result = await adminService.purgeDeadEndpoints()
    debug.log(`Purged ${result.purgedEndpoints} dead endpoints and ${result.purgedDeliveries} failed deliveries`)
    await loadFederationStats()
  } catch (error) {
    debug.error('Failed to purge dead endpoints:', error)
  } finally {
    loadingStates.value.purgingDead = false
  }
}

const purgeSingleEndpoint = async (endpoint: DeadEndpoint) => {
  purgingEndpointIds.value.add(endpoint.id)
  try {
    await adminService.purgeSingleEndpoint(endpoint.id, endpoint.endpoint_url)
    deadEndpointsList.value = deadEndpointsList.value.filter(e => e.id !== endpoint.id)
    if (federationStats.value) {
      federationStats.value.endpoint_health.dead_endpoints--
      federationStats.value.endpoint_health.total_endpoints--
    }
  } catch (error) {
    debug.error('Failed to purge endpoint:', error)
  } finally {
    purgingEndpointIds.value.delete(endpoint.id)
  }
}

// Federation maintenance methods
const refreshKeyConsistency = async () => {
  loadingStates.value.keyConsistency = true
  try {
    keyConsistency.value = await adminService.getKeyConsistencyReport()
  } catch (error) {
    debug.error('Failed to load key consistency:', error)
  } finally {
    loadingStates.value.keyConsistency = false
  }
}

const runKeyGenerationSweep = async () => {
  loadingStates.value.keySweep = true
  try {
    const result = await adminService.runKeyGenerationSweep()
    if (result.success) {
      debug.log('Key generation sweep queued:', result.message)
      // Refresh consistency after a short delay to see results
      setTimeout(() => refreshKeyConsistency(), 3000)
    } else {
      debug.error('Key generation sweep failed:', result.message)
    }
  } catch (error) {
    debug.error('Failed to run key sweep:', error)
  } finally {
    loadingStates.value.keySweep = false
  }
}

const runOrphanCleanup = async () => {
  loadingStates.value.orphanCleanup = true
  try {
    const result = await adminService.runOrphanedKeyCleanup()
    if (result.success) {
      debug.log('Orphan cleanup queued:', result.message)
      setTimeout(() => refreshKeyConsistency(), 3000)
    } else {
      debug.error('Orphan cleanup failed:', result.message)
    }
  } catch (error) {
    debug.error('Failed to run orphan cleanup:', error)
  } finally {
    loadingStates.value.orphanCleanup = false
  }
}

const loadInstanceStats = async () => {
  try {
    const stats = await adminService.getInstanceStats()
    instanceStats.value = stats
  } catch (error) {
    debug.error('Failed to load instance stats:', error)
  }
}

const loadFederatedInstances = async () => {
  loadingStates.value.instances = true
  try {
    const instances = await adminService.getFederatedInstances({
      filter: instanceFilter.value,
      limit: instancePagination.value.limit,
      offset: instancePagination.value.offset,
      search: instanceSearch.value
    })
    federatedInstances.value = instances.instances
    instancePagination.value.total = instances.total
  } catch (error) {
    debug.error('Failed to load federated instances:', error)
  } finally {
    loadingStates.value.instances = false
  }
}

const debouncedSearchInstances = (() => {
  let timeout: NodeJS.Timeout
  return () => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      instancePagination.value.offset = 0
      loadFederatedInstances()
    }, 300)
  }
})()

const loadPreviousInstances = () => {
  if (instancePagination.value.offset >= instancePagination.value.limit) {
    instancePagination.value.offset -= instancePagination.value.limit
    loadFederatedInstances()
  }
}

const loadNextInstances = () => {
  if (instancePagination.value.offset + instancePagination.value.limit < instancePagination.value.total) {
    instancePagination.value.offset += instancePagination.value.limit
    loadFederatedInstances()
  }
}

const isInstanceInactive = (instance: FederatedInstance) => {
  if (!instance.last_seen_at) return true
  const daysSinceLastSeen = (Date.now() - new Date(instance.last_seen_at).getTime()) / (1000 * 60 * 60 * 24)
  return daysSinceLastSeen > 7
}

const refreshInstance = async (instanceId: string) => {
  try {
    await adminService.refreshInstanceInfo(instanceId)
    await loadFederatedInstances()
  } catch (error) {
    debug.error('Failed to refresh instance:', error)
    toast.error('Failed to refresh instance info')
  }
}

const toggleInstanceTrust = async (instanceId: string, trusted: boolean) => {
  try {
    await adminService.updateInstanceTrust(instanceId, trusted, authStore.session?.user?.id || '')
    await loadFederatedInstances()
    await loadInstanceStats()
  } catch (error) {
    debug.error('Failed to update instance trust:', error)
    toast.error('Failed to update instance trust')
  }
}

const toggleInstanceBlock = async (instanceId: string, blocked: boolean) => {
  try {
    const reason = blocked ? prompt('Block reason:') || 'Admin decision' : 'Admin unblock'
    await adminService.updateInstanceBlock(instanceId, blocked, reason, authStore.session?.user?.id || '')
    await loadFederatedInstances()
    await loadInstanceStats()
  } catch (error) {
    debug.error('Failed to update instance block status:', error)
    toast.error('Failed to update instance block status')
  }
}

const toggleInstanceLimit = async (domain: string, limit: boolean) => {
  try {
    const reason = limit ? prompt(`Reason for limiting ${domain}:`) : null
    if (limit && reason === null) return
    await adminService.setDomainModeration(domain, limit ? 'limit' : 'none', reason ?? undefined)
    toast.success(limit ? `${domain} limited` : `Limit on ${domain} lifted`)
    await loadFederatedInstances()
  } catch (error) {
    debug.error('Failed to change domain limit:', error)
    toast.error('Failed to change the domain limit')
  }
}

const deleteInstance = async (instanceId: string) => {
  const ok = await confirm({
    title: 'Delete instance',
    message: 'Are you sure you want to delete this instance? This will remove all federation data.',
    confirmButtonText: 'Delete',
    dangerAction: true,
  })
  if (!ok) return
  
  try {
    await adminService.deleteInstance(instanceId, authStore.session?.user?.id || '')
    await loadFederatedInstances()
    await loadInstanceStats()
  } catch (error) {
    debug.error('Failed to delete instance:', error)
    toast.error('Failed to delete instance')
  }
}

const loadDiscoveredInstances = async () => {
  try {
    const discovered = await adminService.getDiscoveredInstances()
    discoveredInstances.value = discovered
  } catch (error) {
    debug.error('Failed to load discovered instances:', error)
  }
}

const addDiscoveredInstance = async (domain: string) => {
  try {
    await adminService.addInstanceFromDomain(domain, false, authStore.session?.user?.id || '')
    await loadFederatedInstances()
    await loadInstanceStats()
    discoveredInstances.value = discoveredInstances.value.filter(i => i.domain !== domain)
  } catch (error) {
    debug.error('Failed to add discovered instance:', error)
    toast.error('Failed to add instance')
  }
}

const discoverInstance = async () => {
  if (!newInstanceDomain.value) return
  
  loadingStates.value.discovering = true
  try {
    const result = await adminService.discoverInstance(newInstanceDomain.value)
    discoveryResult.value = result
  } catch (error) {
    debug.error('Failed to discover instance:', error)
    toast.error('Failed to discover instance. Check if the domain is valid and supports ActivityPub.')
  } finally {
    loadingStates.value.discovering = false
  }
}

const addInstanceFromDiscovery = async () => {
  if (!discoveryResult.value) return
  
  try {
    await adminService.addInstanceFromDomain(
      discoveryResult.value.domain, 
      addAsTrusted.value,
      authStore.session?.user?.id || ''
    )
    await loadFederatedInstances()
    await loadInstanceStats()
    
    newInstanceDomain.value = ''
    discoveryResult.value = null
    addAsTrusted.value = false
    
    toast.success('Instance added')
  } catch (error) {
    debug.error('Failed to add instance:', error)
    toast.error('Failed to add instance')
  }
}

const handleAddInstance = () => {
  // Switch to search tab and focus on input
  discoveryTab.value = 'search'
  newInstanceDomain.value = ''
  discoveryResult.value = null
  addAsTrusted.value = false
}

onMounted(() => {
  void refreshFederationData()
  void refreshKeyConsistency()
  void loadDiscoveredInstances()
})
</script>

<style scoped>


.federation-section {
  margin-bottom: 32px;
}



.federation-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-primary);
}



.instance-info .domain {
  font-weight: 600;
  color: var(--text-primary);
}



.instance-info .reason {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}



.federation-module {
  grid-column: 1 / -1; /* Span full width */
}



.federation-section {
  padding: 24px;
  border-bottom: 1px solid var(--border-color);
}



.federation-section:last-child {
  border-bottom: none;
}



.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}



.section-header h3 {
  margin: 0;
}



.health-indicator {
  padding: 4px 12px;
  border-radius: var(--radius-full);
  font-size: 12px;
  font-weight: 600;
}



.health-indicator.healthy {
  background: color-mix(in srgb, var(--success) 20%, transparent);
  color: var(--success);
}



.health-indicator.warning {
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--warning);
}



.health-indicator.error {
  background: color-mix(in srgb, var(--error) 20%, transparent);
  color: var(--error);
}



.endpoint-details {
  margin-top: 16px;
}



.warning-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: var(--radius-md);
  color: var(--warning);
  font-size: 14px;
  flex-wrap: wrap;
}



.purge-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--radius-base);
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
  background: color-mix(in srgb, var(--error) 15%, transparent);
  color: var(--error);
  transition: all 0.2s ease;
  white-space: nowrap;
}



.purge-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--error) 30%, transparent);
  border-color: color-mix(in srgb, var(--error) 60%, transparent);
}



.purge-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}



.dead-endpoints-list {
  margin-top: 10px;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
}

.dead-endpoint-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  transition: background 0.15s ease;
}

.dead-endpoint-row:last-child {
  border-bottom: none;
}

.dead-endpoint-row:hover {
  background: var(--background-modifier-hover);
}

.dead-endpoint-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dead-endpoint-url {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dead-endpoint-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.dead-endpoint-error {
  font-size: 0.75rem;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.maintenance-status .status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: var(--radius-md);
  font-size: 14px;
  width: 100%;
}

.maintenance-status .status-indicator.ok {
  background: color-mix(in srgb, var(--success) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
  color: var(--success);
}

.maintenance-status .status-indicator.needs_attention {
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  color: var(--warning);
}

.meta-tag {
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  white-space: nowrap;
}



.meta-tag.domain {
  color: var(--harmony-primary);
  background: color-mix(in srgb, var(--harmony-primary) 12%, transparent);
}



.meta-tag.failures {
  color: var(--error);
  background: color-mix(in srgb, var(--error) 12%, transparent);
}



.purge-single-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-base);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
  margin-top: 2px;
}



.purge-single-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--error) 15%, transparent);
  border-color: color-mix(in srgb, var(--error) 30%, transparent);
  color: var(--error);
}



.purge-single-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}



/* Federation Maintenance Styles */
.section-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}



.section-header-row h3 {
  margin: 0;
}



.maintenance-status {
  margin-bottom: 20px;
}



.maintenance-actions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}



.maintenance-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}



.maintenance-info h4 {
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}



.maintenance-info p {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}



.maintenance-card .action-btn.primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}



.scheduled-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--background-modifier-hover);
  border-radius: var(--radius-base);
  font-size: 12px;
  color: var(--text-muted);
}



.federation-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 16px;
  padding: 24px;
  border-bottom: 1px solid var(--border-color);
}



.section-controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}



.filter-controls {
  display: flex;
  gap: 12px;
  align-items: center;
}



.instance-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}



.instance-item {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  transition: all 0.2s ease;
}



.instance-item:hover {
  border-color: var(--harmony-primary);
}



.instance-item.blocked {
  border-color: color-mix(in srgb, var(--error) 50%, transparent);
  background: color-mix(in srgb, var(--error) 5%, transparent);
}



.instance-item.trusted {
  border-color: color-mix(in srgb, var(--success) 50%, transparent);
  background: color-mix(in srgb, var(--success) 5%, transparent);
}



.instance-item.inactive {
  opacity: 0.6;
}



.instance-main {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 16px;
}



.instance-info {
  flex: 1;
}



.instance-domain {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}



.instance-badges {
  display: flex;
  gap: 6px;
}



.instance-details {
  display: flex;
  gap: 16px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}



.detail-item {
  white-space: nowrap;
}



.instance-description {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
  max-width: 400px;
}



.instance-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}



.discovery-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 20px;
  background: var(--background-tertiary);
  border-radius: var(--radius-md);
  padding: 4px;
}



.tab-btn {
  flex: 1;
  padding: 8px 16px;
  background: transparent;
  border: none;
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}



.tab-btn.active {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}



.discovery-content {
  min-height: 200px;
}



.discovered-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}



.discovered-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
}



.discovered-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}



.interaction-count {
  font-size: 12px;
  color: var(--text-secondary);
}



.search-form {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}



.search-form input {
  flex: 1;
}



.discovery-result {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}



.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--background-tertiary);
  border-bottom: 1px solid var(--border-color);
}



.result-header h4 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}



.result-badges {
  display: flex;
  gap: 8px;
}



.result-details {
  padding: 16px;
}



.detail-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 14px;
}



.detail-row strong {
  min-width: 80px;
  color: var(--text-secondary);
}



.result-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--background-tertiary);
  border-top: 1px solid var(--border-color);
}



.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
}

@media (max-width: 480px) {

  /* Wide rows (instance lists, user rows) scroll instead of overflowing. */
  .users-list,
  .servers-list,
  .reports-list,
  .supporters-list,
  .discovery-content {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
}
</style>

<style scoped src="./adminShared.css"></style>
