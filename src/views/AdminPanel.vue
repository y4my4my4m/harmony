<template>
  <div class="admin-panel">
    <div class="admin-header">
      <div class="admin-title">
        <Icon name="admin-terminal" :size="24" />
        <h1>Instance Control Panel</h1>
        <div class="system-status" :class="systemStatus.class">
          <div class="status-indicator"></div>
          <span>{{ systemStatus.text }}</span>
        </div>
      </div>
      <div class="admin-actions">
        <button @click="refreshData" class="action-btn refresh-btn" :disabled="loading">
          <Icon name="refresh" :size="16" />
          Refresh
        </button>
        <button @click="exportLogs" class="action-btn export-btn">
          <Icon name="download" :size="16" />
          Export Logs
        </button>
      </div>
    </div>

    <nav class="admin-tabs" role="tablist">
      <button
        v-for="tab in adminTabs"
        :key="tab.key"
        role="tab"
        :aria-selected="activeAdminTab === tab.key"
        :class="['admin-tab-btn', { active: activeAdminTab === tab.key }]"
        @click="activeAdminTab = tab.key"
      >
        <Icon :name="tab.icon" :size="15" />
        {{ tab.label }}
      </button>
    </nav>

    <div v-if="activeAdminTab === 'overview'" class="admin-grid">
      <!-- System Overview -->
      <div class="admin-module overview-module">
        <div class="module-header">
          <Icon name="dashboard" :size="20" />
          <h2>System Overview</h2>
          <div class="uptime">{{ formatUptime(systemStats.uptime) }}</div>
        </div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">
              <Icon name="users" :size="24" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ systemStats.totalUsers }}</div>
              <div class="stat-label">Total Users</div>
              <div class="stat-change positive">+{{ systemStats.newUsersToday }} today</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">
              <Icon name="server" :size="24" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ systemStats.totalServers }}</div>
              <div class="stat-label">Chat Servers</div>
              <div class="stat-change">{{ systemStats.activeServers }} active</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">
              <Icon name="federation" :size="24" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ systemStats.federatedInstances }}</div>
              <div class="stat-label">Federated Instances</div>
              <div class="stat-change positive">{{ systemStats.federationHealth }}% healthy</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">
              <Icon name="message" :size="24" />
            </div>
            <div class="stat-content">
              <div class="stat-value">{{ formatNumber(systemStats.totalPosts) }}</div>
              <div class="stat-label">Total Posts</div>
              <div class="stat-change">{{ systemStats.postsToday }} today</div>
            </div>
          </div>
        </div>
      </div>

      <!-- System Health -->
      <div class="admin-module health-module">
        <div class="module-header">
          <Icon name="health" :size="20" />
          <h2>System Health</h2>
          <div class="health-indicator" :class="healthStatus.class">
            {{ healthStatus.text }}
          </div>
        </div>
        <div class="health-metrics">
          <div class="metric-card">
            <div class="metric-header">
              <span>Database</span>
              <div class="metric-status healthy"></div>
            </div>
            <div class="metric-value">{{ systemHealth.database.responseTime }}ms</div>
            <div class="metric-detail">{{ systemHealth.database.connections }} connections</div>
          </div>
          <div class="metric-card">
            <div class="metric-header">
              <span>Federation Queue</span>
              <div class="metric-status" :class="systemHealth.federation.status"></div>
            </div>
            <div class="metric-value">{{ systemHealth.federation.pending }}</div>
            <div class="metric-detail">pending deliveries</div>
          </div>
          <div class="metric-card">
            <div class="metric-header">
              <span>Database Size</span>
              <div class="metric-status healthy"></div>
            </div>
            <div class="metric-value">{{ systemHealth.storage.total }}</div>
            <div class="metric-detail">total size</div>
          </div>
          <div class="metric-card placeholder-metric">
            <div class="metric-header">
              <span>Memory</span>
              <div class="metric-status healthy"></div>
            </div>
            <div class="metric-value">--</div>
            <div class="metric-detail">not available via Supabase</div>
          </div>
        </div>
      </div>

      <!-- Recent Activity -->
      <ActivityLog />
    </div>

    <div v-else-if="activeAdminTab === 'federation'" class="admin-grid single">
      <FederationManagement />
    </div>

    <div v-else-if="activeAdminTab === 'users'" class="admin-grid single">
      <UserManagement />
    </div>

    <div v-else-if="activeAdminTab === 'reports'" class="admin-grid single">
      <ReportsModeration />
    </div>

    <div v-else-if="activeAdminTab === 'content'" class="admin-grid">
      <AnnouncementsAdmin />
      <FeaturedCommunities />
    </div>

    <div v-else-if="activeAdminTab === 'config'" class="admin-grid single">
      <InstanceConfig />
    </div>

    <div v-else-if="activeAdminTab === 'funding'" class="admin-grid single">
      <FundingSupporters />
    </div>

    <div v-else-if="activeAdminTab === 'tools'" class="admin-grid">
      <!-- Performance Monitoring -->
      <div class="admin-module performance-module">
        <div class="module-header">
          <Icon name="activity" :size="20" />
          <h2>Performance Monitoring</h2>
        </div>
        <div class="performance-content">
          <PerformanceMonitoring />
        </div>
      </div>

      <!-- Emoji Importer -->
      <div class="admin-module emoji-module">
        <div class="module-header">
          <Icon name="emoji" :size="20" />
          <h2>Remote Emoji Importer</h2>
        </div>
        <div class="emoji-content">
          <EmojiImporter />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, defineAsyncComponent } from 'vue'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import { useRouter, useRoute } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import ActivityLog from '@/components/admin/ActivityLog.vue'

// Modules load lazily per tab so opening the panel only fetches Overview.
const EmojiImporter = defineAsyncComponent(() => import('@/components/admin/EmojiImporter.vue'))
const PerformanceMonitoring = defineAsyncComponent(() => import('@/components/admin/PerformanceMonitoring.vue'))
const FederationManagement = defineAsyncComponent(() => import('@/components/admin/FederationManagement.vue'))
const UserManagement = defineAsyncComponent(() => import('@/components/admin/UserManagement.vue'))
const ReportsModeration = defineAsyncComponent(() => import('@/components/admin/ReportsModeration.vue'))
const AnnouncementsAdmin = defineAsyncComponent(() => import('@/components/admin/AnnouncementsAdmin.vue'))
const FeaturedCommunities = defineAsyncComponent(() => import('@/components/admin/FeaturedCommunities.vue'))
const InstanceConfig = defineAsyncComponent(() => import('@/components/admin/InstanceConfig.vue'))
const FundingSupporters = defineAsyncComponent(() => import('@/components/admin/FundingSupporters.vue'))
import { adminService } from '@/services/AdminService'

const authStore = useAuthStore()
const router = useRouter()
const route = useRoute()

const adminTabs = [
  { key: 'overview', label: 'Overview', icon: 'dashboard' },
  { key: 'federation', label: 'Federation', icon: 'federation' },
  { key: 'users', label: 'Users', icon: 'users' },
  { key: 'reports', label: 'Reports', icon: 'flag' },
  { key: 'content', label: 'Content', icon: 'megaphone' },
  { key: 'config', label: 'Config', icon: 'settings' },
  { key: 'funding', label: 'Funding', icon: 'heart' },
  { key: 'tools', label: 'Tools', icon: 'wrench' },
] as const
type AdminTabKey = typeof adminTabs[number]['key']

const initialTab = adminTabs.find(t => t.key === route.query.tab) ? route.query.tab as AdminTabKey : 'overview'
const activeAdminTab = ref<AdminTabKey>(initialTab)
watch(activeAdminTab, (tab) => {
  router.replace({ query: { ...route.query, tab: tab === 'overview' ? undefined : tab } }).catch(() => {})
})

// Security check - only allow admins
onMounted(async () => {
  if (!authStore.session?.user?.id) {
    router.push('/login')
    return
  }

  // Check if user is admin using AdminService
  const isAdmin = await adminService.checkAdminPermissions(authStore.session.user.id)
  
  if (!isAdmin) {
    router.push('/')
    return
  }

  await loadInitialData()
})

// Reactive data
const loading = ref(false)





// User servers modal


// System stats
const systemStats = ref({
  uptime: 0,
  totalUsers: 0,
  newUsersToday: 0,
  totalServers: 0,
  activeServers: 0,
  federatedInstances: 0,
  federationHealth: 0,
  totalPosts: 0,
  postsToday: 0
})

// System health
const systemHealth = ref({
  database: { responseTime: 0, connections: 0 },
  federation: { pending: 0, status: 'healthy' },
  storage: { used: 0, total: '100GB' },
  memory: { used: 0, total: '16GB' }
})


// Computed properties
const systemStatus = computed(() => {
  const health = systemHealth.value
  if (health.federation.status === 'error') {
    return { class: 'error', text: 'Federation Issues' }
  }
  if (health.memory.used > 90) {
    return { class: 'warning', text: 'High Memory Usage' }
  }
  return { class: 'healthy', text: 'All Systems Operational' }
})

// eslint-disable-next-line unused-imports/no-unused-vars
const federationStatus = computed(() => {
  const pending = systemHealth.value.federation.pending
  if (pending > 100) {
    return { class: 'warning', text: `${pending} pending deliveries` }
  }
  return { class: 'healthy', text: 'Federation Active' }
})

const healthStatus = computed(() => {
  const issues = []
  if (systemHealth.value.memory.used > 90) issues.push('memory')
  if (systemHealth.value.federation.status === 'error') issues.push('federation')
  
  if (issues.length === 0) return { class: 'healthy', text: 'Healthy' }
  if (issues.length === 1) return { class: 'warning', text: 'Minor Issues' }
  return { class: 'error', text: 'Critical Issues' }
})



// Methods
const loadInitialData = async () => {
  loading.value = true
  try {
    // Core dashboard data gates the global spinner; every slower/secondary
    // section streams in behind its own per-section loadingStates flag so one
    // slow federation query doesn't hold the whole panel on a spinner.
    // allSettled: one failed loader must not abort the rest.
    await Promise.allSettled([
      loadSystemStats(),
      loadSystemHealth(),
    ])

    void Promise.allSettled([
    ])
  } catch (error) {
    debug.error('Failed to load admin data:', error)
  } finally {
    loading.value = false
  }
}

const loadSystemStats = async () => {
  try {
    const stats = await adminService.getSystemStats()
    
    systemStats.value = {
      uptime: stats.uptime || Date.now() - (7 * 24 * 60 * 60 * 1000),
      totalUsers: stats.total_users,
      newUsersToday: stats.newUsersToday || 0,
      totalServers: stats.total_servers,
      activeServers: stats.active_servers,
      federatedInstances: stats.federated_instances,
      federationHealth: 95, // Mock for now
      totalPosts: stats.total_posts,
      postsToday: stats.postsToday || 0
    }
  } catch (error) {
    debug.error('Failed to load system stats:', error)
    // Set defaults on error
    systemStats.value = {
      uptime: Date.now() - (7 * 24 * 60 * 60 * 1000),
      totalUsers: 0,
      newUsersToday: 0,
      totalServers: 0,
      activeServers: 0,
      federatedInstances: 0,
      federationHealth: 0,
      totalPosts: 0,
      postsToday: 0
    }
  }
}

const loadSystemHealth = async () => {
  try {
    systemHealth.value = await adminService.getSystemHealth()
  } catch (error) {
    debug.error('Failed to load system health:', error)
    // Set defaults
    systemHealth.value = {
      database: { responseTime: 0, connections: 0 },
      federation: { pending: 0, status: 'error' },
      storage: { used: 0, total: '100GB' },
      memory: { used: 0, total: '16GB' }
    }
  }
}

const refreshData = async () => {
  await loadInitialData()
}

const exportLogs = () => {
  // Export system logs
  debug.log('Exporting logs...')
}

// Utility functions
const formatUptime = (timestamp: number) => {
  const diff = Date.now() - timestamp
  const days = Math.floor(diff / (24 * 60 * 60 * 1000))
  const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
  return `${days}d ${hours}h`
}

const formatNumber = (num: number | undefined) => {
  if (num === undefined || num === null) return '0'
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}


</script>

<style scoped>
.admin-panel {
  padding: 24px;
  background: var(--background-primary);
  min-height: 100vh;
  color: var(--text-primary);
  font-family: var(--font-family);
  overflow-y: auto;
}









.admin-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 32px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}









.admin-title {
  display: flex;
  align-items: center;
  gap: 12px;
}









.admin-title h1 {
  font-size: 28px;
  font-weight: 700;
  margin: 0;
  background: linear-gradient(135deg, #00d4ff, #00ff88);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}









.system-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}









.system-status.healthy {
  background: rgba(0, 255, 136, 0.1);
  color: #00ff88;
  border: 1px solid rgba(0, 255, 136, 0.3);
}









.system-status.warning {
  background: rgba(255, 193, 7, 0.1);
  color: #ffc107;
  border: 1px solid rgba(255, 193, 7, 0.3);
}









.system-status.error {
  background: rgba(255, 69, 58, 0.1);
  color: #ff453a;
  border: 1px solid rgba(255, 69, 58, 0.3);
}









.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 2s infinite;
}









@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}









.admin-actions {
  display: flex;
  gap: 12px;
}









.action-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}









.action-btn:hover {
  background: var(--background-tertiary);
  border-color: var(--accent-color);
  transform: translateY(-1px);
}









.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}









.admin-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 12px;
}

.admin-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--background-secondary);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.admin-tab-btn:hover {
  color: var(--text-primary);
  border-color: var(--accent-color);
}

.admin-tab-btn.active {
  color: var(--accent-color);
  border-color: var(--accent-color);
  background: color-mix(in srgb, var(--accent-color) 10%, transparent);
}

.admin-grid.single {
  grid-template-columns: 1fr;
}

.admin-grid {
  display: grid;
  /* min(600px, 100%) lets tracks collapse below 600px instead of overflowing */
  grid-template-columns: repeat(auto-fit, minmax(min(600px, 100%), 1fr));
  gap: 24px;
}









.admin-module {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  min-width: 0;
  transition: all 0.3s ease;
}









.admin-module:hover {
  border-color: var(--accent-color);
  box-shadow: 0 8px 32px rgba(0, 212, 255, 0.1);
  transform: translateY(-2px);
}









.module-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 24px;
  background: linear-gradient(135deg, rgba(0, 212, 255, 0.05), rgba(0, 255, 136, 0.05));
  border-bottom: 1px solid var(--border-color);
}









.module-header h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
  flex: 1;
}









.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  padding: 24px;
}









.stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: var(--background-tertiary);
  border: 1px solid rgba(0, 212, 255, 0.2);
  border-radius: 8px;
  transition: all 0.2s ease;
}









.stat-card:hover {
  border-color: var(--accent-color);
  box-shadow: 0 4px 16px rgba(0, 212, 255, 0.1);
}









.stat-icon {
  padding: 12px;
  background: linear-gradient(135deg, rgba(0, 212, 255, 0.1), rgba(0, 255, 136, 0.1));
  border-radius: 8px;
  color: #00d4ff;
}









.stat-content {
  flex: 1;
}









.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}









.stat-label {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}









.stat-change {
  font-size: 12px;
  font-weight: 500;
}









.stat-change.positive {
  color: #00ff88;
}









/* Federation Module */
.federation-content {
  padding: 24px;
}









.cyber-input, .cyber-textarea, .cyber-select {
  width: 100%;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  transition: all 0.2s ease;
}









.cyber-input:focus, .cyber-textarea:focus, .cyber-select:focus {
  outline: none;
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px rgba(0, 212, 255, 0.1);
}









.cyber-textarea {
  resize: vertical;
  min-height: 80px;
}









.toggle-label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
}









/* Override parent label styles so toggles stay horizontal and text doesn't truncate */
.setting-group .toggle-label,
.announcement-form .form-row.checks .toggle-label {
  display: flex;
  margin-bottom: 0;
}









.toggle-label .toggle-slider {
  flex-shrink: 0;
}









.toggle-label .toggle-text {
  flex-shrink: 0;
  white-space: nowrap;
}









.toggle-label input[type="checkbox"] {
  display: none;
}









.toggle-slider {
  position: relative;
  width: 44px;
  height: 24px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  transition: all 0.2s ease;
}









.toggle-slider:before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  background: var(--text-secondary);
  border-radius: 50%;
  transition: all 0.2s ease;
}









.toggle-label input[type="checkbox"]:checked + .toggle-slider {
  background: var(--accent-color);
  border-color: var(--accent-color);
}









.toggle-label input[type="checkbox"]:checked + .toggle-slider:before {
  left: 22px;
  background: white;
}









/* Blocked Instances */
.blocked-instances {
  space-y: 16px;
}









.blocked-instance {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: var(--background-tertiary);
  border: 1px solid rgba(255, 69, 58, 0.2);
  border-radius: 8px;
  margin-bottom: 12px;
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









.unblock-btn {
  padding: 8px 12px;
  background: rgba(255, 69, 58, 0.1);
  border: 1px solid rgba(255, 69, 58, 0.3);
  border-radius: 6px;
  color: #ff453a;
  cursor: pointer;
  transition: all 0.2s ease;
}









/* Federation Management Styles */
.module-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}









.primary-btn, .primary-btn-sm {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--accent-color);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}









.primary-btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}









.primary-btn:hover, .primary-btn-sm:hover {
  background: #0099cc;
  transform: translateY(-1px);
}









.spinner-small {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 69, 58, 0.3);
  border-top-color: #ff453a;
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.8s linear infinite;
}









.meta-tag.domain {
  color: var(--harmony-primary, #7c8aff);
  background: rgba(124, 138, 255, 0.12);
}









.meta-tag.failures {
  color: #ff453a;
  background: rgba(255, 69, 58, 0.12);
}









.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 14px;
  width:100%;
}









.status-indicator.ok {
  background: rgba(0, 255, 136, 0.1);
  border: 1px solid rgba(0, 255, 136, 0.3);
  color: #00ff88;
}









.status-indicator.needs_attention {
  background: rgba(255, 193, 7, 0.1);
  border: 1px solid rgba(255, 193, 7, 0.3);
  color: #ffc107;
}









.maintenance-card .action-btn.primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}









.spin {
  animation: spin 1s linear infinite;
}









@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}









.error-text {
  color: #ff453a;
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









.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: var(--text-secondary);
}









.badge {
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}









.badge.trusted {
  background: rgba(0, 255, 136, 0.2);
  color: #00ff88;
}









.badge.blocked {
  background: rgba(255, 69, 58, 0.2);
  color: #ff453a;
}









.badge.inactive {
  background: rgba(156, 163, 175, 0.2);
  color: #9ca3af;
}









.badge.success {
  background: rgba(0, 255, 136, 0.2);
  color: #00ff88;
}









.badge.info {
  background: rgba(0, 212, 255, 0.2);
  color: #00d4ff;
}









.detail-item {
  white-space: nowrap;
}









.action-btn-sm, .danger-btn-sm {
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}









.action-btn-sm:hover {
  border-color: var(--accent-color);
  color: var(--accent-color);
}









.action-btn-sm.trusted {
  border-color: rgba(0, 255, 136, 0.5);
  color: #00ff88;
}









.danger-btn-sm:hover {
  border-color: rgba(255, 69, 58, 0.5);
  color: #ff453a;
}









.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 20px;
  border-top: 1px solid var(--border-color);
}









.pagination-btn {
  padding: 8px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}









.pagination-btn:hover:not(:disabled) {
  border-color: var(--accent-color);
  color: var(--accent-color);
}









.pagination-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}









.pagination-info {
  color: var(--text-secondary);
  font-size: 14px;
}









.tab-btn {
  flex: 1;
  padding: 8px 16px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}









.tab-btn.active {
  background: var(--accent-color);
  color: var(--text-primary);
}









.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px;
  text-align: center;
  color: var(--text-secondary);
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









.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
}









.spinning {
  animation: spin 1s linear infinite;
}









.search-bar .cyber-input {
  padding-left: 36px;
  max-width: 200px;
}









.search-bar .icon {
  position: absolute;
  left: 12px;
  color: var(--text-secondary);
}









.user-name .badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
}









.badge.suspended {
  background: rgba(255, 193, 7, 0.2);
  color: #ffc107;
}









.badge.admin {
  background: rgba(0, 212, 255, 0.2);
  color: #00d4ff;
}









.badge.moderator {
  background: rgba(46, 204, 113, 0.2);
  color: #2ecc71;
}









/* Health Module */
.health-metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  padding: 24px;
}









.metric-card {
  padding: 20px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}









.metric-card.placeholder-metric {
  opacity: 0.5;
}









.metric-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
}









.metric-status {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}









.metric-status.healthy {
  background: #00ff88;
}









.metric-status.warning {
  background: #ffc107;
}









.metric-status.error {
  background: #ff453a;
}









.metric-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}









.metric-detail {
  font-size: 12px;
  color: var(--text-secondary);
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








.announcement-form .form-row { margin-bottom: 12px; }








.announcement-form .form-row label { display: block; font-size: 13px; margin-bottom: 4px; color: var(--text-secondary); }








.announcement-form .form-row.checks { display: flex; gap: 16px; flex-wrap: wrap; }








.announcement-form .form-row.two-col {
  /* Two-up layout for the scheduling inputs so the form doesn't get
     unnecessarily tall. Collapses to a stack on narrow viewports. */
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 640px) {




  .announcement-form .form-row.two-col { grid-template-columns: 1fr; }
}








.announcement-form .form-row.two-col > div { display: flex; flex-direction: column; }








.announcement-form .form-row.two-col label { margin-bottom: 4px; }








.announcement-form .form-hint {
  margin: 4px 0 0 0;
  font-size: 11px;
  color: var(--text-muted, #949ba4);
  line-height: 1.35;
}








.announcement-form .form-actions { display: flex; gap: 8px; margin-top: 16px; }








.announcement-item .badge.inactive { background: var(--background-quaternary); color: var(--text-muted); }









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








.featured-server-item .action-btn-sm.pin-btn { color: var(--accent-color); }








.featured-server-item .action-btn-sm.unpin-btn { color: var(--text-secondary); }








.featured-server-item .action-btn-sm { display: flex; align-items: center; gap: 6px; }









/* Emoji Importer Module */
.emoji-module {
  grid-column: span 2; /* Full width like other major modules */
  max-height: 1130px;
}









.emoji-content {
  padding: 0;
  overflow-y: auto;
}









/* Performance Monitoring Module */
.performance-module {
  grid-column: 1 / -1; /* Full width */
}









.performance-content {
  padding: 0;
  max-height: 800px;
  overflow-y: auto;
}









.config-tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}









.config-tab-btn:hover {
  color: var(--text-primary);
  background: var(--background-tertiary);
  border-radius: 6px 6px 0 0;
}









.config-tab-btn.active {
  color: var(--accent-color);
  border-bottom-color: var(--accent-color);
}









/* Responsive Design */
@media (max-width: 1200px) {
  .admin-grid {
    grid-template-columns: 1fr;
  }
  
  .stats-grid {
    grid-template-columns: 1fr;
  }
  
  .health-metrics {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {




  .admin-grid {
    display: flex;
    flex-direction: column;
    flex-wrap: wrap;
    gap: 16px;
  }




  .admin-module {
    max-width: calc(100vw - 32px);
  }




  .admin-panel {
    padding: 16px;
  }





  .admin-header {
    flex-direction: column;
    gap: 16px;
    align-items: flex-start;
  }





  .admin-title {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }





  /* Two-up stats read better than a single tall column on phones. */
  .stats-grid {
    grid-template-columns: 1fr 1fr;
  }





  .add-block {
    flex-direction: column;
  }
}

@media (max-width: 480px) {




  .admin-panel {
    padding: 12px;
  }




  .admin-module {
    max-width: calc(100vw - 24px);
  }




  .stats-grid {
    grid-template-columns: 1fr;
  }




  /* Full-width tap targets for the header actions. */
  .admin-actions {
    width: 100%;
    flex-direction: column;
  }




  .admin-actions .action-btn {
    width: 100%;
    justify-content: center;
    min-height: 44px;
  }




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









.badge.owner {
  background: rgba(255, 193, 7, 0.2);
  color: #ffc107;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
}









.server-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}









.report-type-badge.user { background: rgba(14, 165, 233, 0.2); color: #38BDF8; }








.report-type-badge.post { background: rgba(87, 242, 135, 0.2); color: #57f287; }








.report-type-badge.message { background: rgba(254, 231, 92, 0.2); color: #fee75c; }








.report-type-badge.server { background: rgba(235, 69, 158, 0.2); color: #eb459e; }









.report-proof :deep(.report-link) {
  color: var(--accent-color);
  text-decoration: underline;
  word-break: break-all;
}









.report-proof :deep(.report-link:hover) {
  opacity: 0.8;
}









.report-action-btn.investigating {
  background: rgba(14, 165, 233, 0.3);
  color: #38BDF8;
}









.badge.sensitive {
  background: rgba(250, 166, 26, 0.2);
  color: #faa61a;
}









.badge.cw {
  background: rgba(88, 101, 242, 0.2);
  color: #7c8af5;
}









.badge.silenced {
  background: rgba(250, 166, 26, 0.2);
  color: #faa61a;
}









.mod-btn.warning-btn {
  background: rgba(250, 166, 26, 0.15);
  color: #faa61a;
}









.mod-btn.warning-btn:hover {
  background: rgba(250, 166, 26, 0.3);
}









.icon-preview-img {
  height: 1.2em;
  width: auto;
  vertical-align: -0.15em;
  object-fit: contain;
}









.add-tier-form .cyber-input {
  flex: 1;
  min-width: 100px;
}









.funding-link-row .cyber-input {
  min-width: 0;
}









.add-supporter-form .cyber-input {
  flex: 1;
  min-width: 100px;
}









.supporter-search-wrapper .cyber-input {
  width: 100%;
}









.supporter-suggestion-item:hover,
.supporter-suggestion-item.selected {
  background: var(--harmony-primary);
}









.supporter-suggestion-item.selected .supporter-suggestion-handle {
  color: rgba(255, 255, 255, 0.6);
}









/* Dark theme variables (these should be in your global CSS) */
:root {
  --background-primary: #1a1a1a;
  --background-secondary: #2a2a2a;
  --background-tertiary: #3a3a3a;
  --text-primary: #ffffff;
  --text-secondary: #b0b0b0;
  --border-color: #404040;
  --accent-color: #00d4ff;
}
</style> 