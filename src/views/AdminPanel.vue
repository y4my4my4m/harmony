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

    <div class="admin-grid">
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

      <!-- Federation Management -->
      <div class="admin-module federation-module">
        <div class="module-header">
          <Icon name="federation" :size="20" />
          <h2>Federation Control</h2>
          <div class="federation-status" :class="federationStatus.class">
            {{ federationStatus.text }}
          </div>
        </div>
        <div class="federation-content">
          <div class="federation-section">
            <h3>Instance Settings</h3>
            <div class="setting-group">
              <label>Instance Name</label>
              <input v-model="instanceConfig.name" type="text" class="cyber-input" />
            </div>
            <div class="setting-group">
              <label>Domain</label>
              <input v-model="instanceConfig.domain" type="text" class="cyber-input" disabled />
            </div>
            <div class="setting-group">
              <label>Description</label>
              <textarea v-model="instanceConfig.description" class="cyber-textarea"></textarea>
            </div>
            <div class="setting-row">
              <label class="toggle-label">
                <input type="checkbox" v-model="instanceConfig.openRegistration" />
                <span class="toggle-slider"></span>
                Open Registration
              </label>
              <label class="toggle-label">
                <input type="checkbox" v-model="instanceConfig.approvalRequired" />
                <span class="toggle-slider"></span>
                Require Approval
              </label>
            </div>
          </div>
          
          <div class="federation-section">
            <h3>Blocked Instances</h3>
            <div class="blocked-instances">
              <div v-for="instance in blockedInstances" :key="instance.domain" class="blocked-instance">
                <div class="instance-info">
                  <span class="domain">{{ instance.domain }}</span>
                  <span class="reason">{{ instance.reason }}</span>
                </div>
                <button @click="unblockInstance(instance.domain)" class="unblock-btn">
                  <Icon name="unblock" :size="16" />
                </button>
              </div>
              <div class="add-block">
                <input v-model="newBlockDomain" placeholder="Domain to block" class="cyber-input" />
                <input v-model="newBlockReason" placeholder="Reason" class="cyber-input" />
                <button @click="blockInstance" class="block-btn">Block</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- User Management -->
      <div class="admin-module users-module">
        <div class="module-header">
          <Icon name="users" :size="20" />
          <h2>User Management</h2>
          <div class="search-bar">
            <Icon name="search" :size="16" />
            <input v-model="userSearch" placeholder="Search users..." class="cyber-input" />
          </div>
        </div>
        <div class="users-content">
          <div class="user-filters">
            <button 
              v-for="filter in userFilters" 
              :key="filter.key"
              @click="activeUserFilter = filter.key"
              :class="['filter-btn', { active: activeUserFilter === filter.key }]"
            >
              {{ filter.label }} ({{ filter.count }})
            </button>
          </div>
          <div class="users-list">
            <div v-for="user in filteredUsers" :key="user.id" class="user-item">
              <Avatar 
                :src="user.avatar_url" 
                :alt="user.display_name || user.username"
                :size="md"
              />
              <div class="user-info">
                <div class="user-name">{{ user.display_name || user.username }}</div>
                <div class="user-meta">
                  @{{ user.username }}{{ user.domain ? '@' + user.domain : '' }}
                  <span class="user-joined">Joined {{ formatDate(user.created_at) }}</span>
                </div>
              </div>
              <div class="user-stats">
                <span>{{ user.post_count }} posts</span>
                <span>{{ user.server_count }} servers</span>
              </div>
              <div class="user-actions">
                <button @click="moderateUser(user, 'suspend')" class="mod-btn suspend-btn">
                  <Icon name="suspend" :size="16" />
                </button>
                <button @click="moderateUser(user, 'delete')" class="mod-btn delete-btn">
                  <Icon name="delete" :size="16" />
                </button>
              </div>
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
              <span>Storage</span>
              <div class="metric-status healthy"></div>
            </div>
            <div class="metric-value">{{ systemHealth.storage.used }}%</div>
            <div class="metric-detail">{{ systemHealth.storage.total }} total</div>
          </div>
          <div class="metric-card">
            <div class="metric-header">
              <span>Memory</span>
              <div class="metric-status warning"></div>
            </div>
            <div class="metric-value">{{ systemHealth.memory.used }}%</div>
            <div class="metric-detail">{{ systemHealth.memory.total }} available</div>
          </div>
        </div>
      </div>

      <!-- Recent Activity -->
      <div class="admin-module activity-module">
        <div class="module-header">
          <Icon name="activity" :size="20" />
          <h2>Recent Activity</h2>
          <select v-model="activityFilter" class="cyber-select">
            <option value="all">All Events</option>
            <option value="federation">Federation</option>
            <option value="moderation">Moderation</option>
            <option value="security">Security</option>
          </select>
        </div>
        <div class="activity-feed">
          <div v-for="event in recentActivity" :key="event.id" class="activity-item">
            <div class="activity-icon" :class="event.type">
              <Icon :name="getActivityIcon(event.type)" :size="16" />
            </div>
            <div class="activity-content">
              <div class="activity-message">{{ event.message }}</div>
              <div class="activity-meta">
                <span class="activity-time">{{ formatTime(event.timestamp) }}</span>
                <span class="activity-source">{{ event.source }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Configuration -->
      <div class="admin-module config-module">
        <div class="module-header">
          <Icon name="settings" :size="20" />
          <h2>Configuration</h2>
          <button @click="saveConfig" class="save-btn" :disabled="!configChanged">
            <Icon name="save" :size="16" />
            Save Changes
          </button>
        </div>
        <div class="config-sections">
          <div class="config-section">
            <h3>Chat Settings</h3>
            <div class="setting-group">
              <label>Max Server Size</label>
              <input v-model.number="config.chat.maxServerSize" type="number" class="cyber-input" />
            </div>
            <div class="setting-group">
              <label>Max Message Length</label>
              <input v-model.number="config.chat.maxMessageLength" type="number" class="cyber-input" />
            </div>
            <div class="setting-row">
              <label class="toggle-label">
                <input type="checkbox" v-model="config.chat.allowFileUploads" />
                <span class="toggle-slider"></span>
                Allow File Uploads
              </label>
              <label class="toggle-label">
                <input type="checkbox" v-model="config.chat.enableVoiceChannels" />
                <span class="toggle-slider"></span>
                Enable Voice Channels
              </label>
            </div>
          </div>
          
          <div class="config-section">
            <h3>Federation Settings</h3>
            <div class="setting-group">
              <label>Max Post Length</label>
              <input v-model.number="config.federation.maxPostLength" type="number" class="cyber-input" />
            </div>
            <div class="setting-group">
              <label>Delivery Retry Attempts</label>
              <input v-model.number="config.federation.retryAttempts" type="number" class="cyber-input" />
            </div>
            <div class="setting-row">
              <label class="toggle-label">
                <input type="checkbox" v-model="config.federation.enableOutbound" />
                <span class="toggle-slider"></span>
                Enable Outbound Federation
              </label>
              <label class="toggle-label">
                <input type="checkbox" v-model="config.federation.enableInbound" />
                <span class="toggle-slider"></span>
                Enable Inbound Federation
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import { supabase } from '@/supabase'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import type { User } from '@/types'

const authStore = useAuthStore()
const router = useRouter()

// Security check - only allow admins
onMounted(async () => {
  if (!authStore.session?.user?.id) {
    router.push('/login')
    return
  }

  // Check if user is admin (you can modify this logic as needed)
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', authStore.session.user.id)
    .single()

  if (!profile?.is_admin) {
    router.push('/')
    return
  }

  await loadInitialData()
})

// Reactive data
const loading = ref(false)
const userSearch = ref('')
const activeUserFilter = ref('all')
const activityFilter = ref('all')
const newBlockDomain = ref('')
const newBlockReason = ref('')
const configChanged = ref(false)

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

// Instance configuration
const instanceConfig = ref({
  name: 'Harmony Instance',
  domain: 'har.mony.lol',
  description: 'A federated social platform',
  openRegistration: true,
  approvalRequired: false
})

// Configuration
const config = ref({
  chat: {
    maxServerSize: 1000,
    maxMessageLength: 2000,
    allowFileUploads: true,
    enableVoiceChannels: true
  },
  federation: {
    maxPostLength: 500,
    retryAttempts: 3,
    enableOutbound: true,
    enableInbound: true
  }
})

// Users data
const users = ref<User[]>([])
const blockedInstances = ref([
  { domain: 'bad-instance.com', reason: 'Spam and harassment' },
  { domain: 'another-bad.net', reason: 'Policy violations' }
])

const recentActivity = ref([
  {
    id: 1,
    type: 'federation',
    message: 'Successfully federated with mastodon.social',
    timestamp: new Date(Date.now() - 300000),
    source: 'Federation Service'
  },
  {
    id: 2,
    type: 'security',
    message: 'Failed login attempt from 192.168.1.100',
    timestamp: new Date(Date.now() - 600000),
    source: 'Auth Service'
  },
  {
    id: 3,
    type: 'moderation',
    message: 'User @spammer was suspended by admin',
    timestamp: new Date(Date.now() - 900000),
    source: 'Moderation'
  }
])

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

const userFilters = computed(() => [
  { key: 'all', label: 'All Users', count: users.value.length },
  { key: 'local', label: 'Local', count: users.value.filter(u => !u.domain).length },
  { key: 'federated', label: 'Federated', count: users.value.filter(u => u.domain).length },
  { key: 'suspended', label: 'Suspended', count: users.value.filter(u => u.is_suspended).length }
])

const filteredUsers = computed(() => {
  let filtered = users.value

  // Apply filter
  if (activeUserFilter.value !== 'all') {
    switch (activeUserFilter.value) {
      case 'local':
        filtered = filtered.filter(u => !u.domain)
        break
      case 'federated':
        filtered = filtered.filter(u => u.domain)
        break
      case 'suspended':
        filtered = filtered.filter(u => u.is_suspended)
        break
    }
  }

  // Apply search
  if (userSearch.value) {
    const search = userSearch.value.toLowerCase()
    filtered = filtered.filter(u => 
      u.username.toLowerCase().includes(search) ||
      u.display_name?.toLowerCase().includes(search) ||
      u.domain?.toLowerCase().includes(search)
    )
  }

  return filtered.slice(0, 50) // Limit results
})

// Watch for config changes
watch(config, () => {
  configChanged.value = true
}, { deep: true })

// Methods
const loadInitialData = async () => {
  loading.value = true
  try {
    await Promise.all([
      loadSystemStats(),
      loadUsers(),
      loadSystemHealth(),
      loadInstanceConfig()
    ])
  } catch (error) {
    console.error('Failed to load admin data:', error)
  } finally {
    loading.value = false
  }
}

const loadSystemStats = async () => {
  // Load from database - this is mock data for now
  const { data: userCount } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })

  const { data: serverCount } = await supabase
    .from('servers')
    .select('id', { count: 'exact', head: true })

  const { data: postCount } = await supabase
    .from('posts')
    .select('id', { count: 'exact', head: true })

  systemStats.value = {
    uptime: Date.now() - (7 * 24 * 60 * 60 * 1000), // 7 days ago
    totalUsers: userCount?.length || 0,
    newUsersToday: 5,
    totalServers: serverCount?.length || 0,
    activeServers: Math.floor((serverCount?.length || 0) * 0.8),
    federatedInstances: 25,
    federationHealth: 95,
    totalPosts: postCount?.length || 0,
    postsToday: 42
  }
}

const loadUsers = async () => {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)

  users.value = data || []
}

const loadSystemHealth = async () => {
  // Mock data - in real implementation, get from monitoring service
  systemHealth.value = {
    database: { responseTime: 12, connections: 25 },
    federation: { pending: 5, status: 'healthy' },
    storage: { used: 45, total: '100GB' },
    memory: { used: 72, total: '16GB' }
  }
}

const loadInstanceConfig = async () => {
  // Load instance configuration
  // This would come from a settings table or config file
}

const refreshData = async () => {
  await loadInitialData()
}

const exportLogs = () => {
  // Export system logs
  console.log('Exporting logs...')
}

const blockInstance = () => {
  if (newBlockDomain.value && newBlockReason.value) {
    blockedInstances.value.push({
      domain: newBlockDomain.value,
      reason: newBlockReason.value
    })
    newBlockDomain.value = ''
    newBlockReason.value = ''
  }
}

const unblockInstance = (domain: string) => {
  const index = blockedInstances.value.findIndex(i => i.domain === domain)
  if (index !== -1) {
    blockedInstances.value.splice(index, 1)
  }
}

const moderateUser = (user: User, action: string) => {
  console.log(`Moderating user ${user.username} with action: ${action}`)
  // Implement moderation actions
}

const saveConfig = async () => {
  try {
    // Save configuration to database
    console.log('Saving configuration...', config.value)
    configChanged.value = false
  } catch (error) {
    console.error('Failed to save configuration:', error)
  }
}

// Utility functions
const formatUptime = (timestamp: number) => {
  const diff = Date.now() - timestamp
  const days = Math.floor(diff / (24 * 60 * 60 * 1000))
  const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
  return `${days}d ${hours}h`
}

const formatNumber = (num: number) => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

const formatDate = (date: string) => {
  return new Date(date).toLocaleDateString()
}

const formatTime = (date: Date) => {
  return date.toLocaleTimeString()
}

const getActivityIcon = (type: string) => {
  switch (type) {
    case 'federation': return 'federation'
    case 'security': return 'shield'
    case 'moderation': return 'gavel'
    default: return 'info'
  }
}
</script>

<style scoped>
.admin-panel {
  padding: 24px;
  background: var(--background-primary);
  min-height: 100vh;
  color: var(--text-primary);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
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

.admin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(600px, 1fr));
  gap: 24px;
}

.admin-module {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
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

.federation-section {
  margin-bottom: 32px;
}

.federation-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-primary);
}

.setting-group {
  margin-bottom: 16px;
}

.setting-group label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
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

.setting-row {
  display: flex;
  gap: 24px;
  align-items: center;
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

.unblock-btn:hover {
  background: rgba(255, 69, 58, 0.2);
}

.add-block {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

.block-btn {
  padding: 12px 24px;
  background: var(--accent-color);
  border: none;
  border-radius: 8px;
  color: white;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.block-btn:hover {
  background: #0099cc;
  transform: translateY(-1px);
}

/* Users Module */
.users-content {
  padding: 24px;
}

.user-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}

.filter-btn {
  padding: 8px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.filter-btn:hover, .filter-btn.active {
  background: var(--accent-color);
  border-color: var(--accent-color);
  color: white;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
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

.users-list {
  space-y: 12px;
}

.user-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.user-item:hover {
  border-color: var(--accent-color);
}

.user-info {
  flex: 1;
}

.user-name {
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.user-meta {
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  gap: 12px;
  align-items: center;
}

.user-stats {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}

.user-actions {
  display: flex;
  gap: 8px;
}

.mod-btn {
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.mod-btn:hover {
  border-color: var(--accent-color);
  color: var(--text-primary);
}

.suspend-btn:hover {
  border-color: #ffc107;
  color: #ffc107;
}

.delete-btn:hover {
  border-color: #ff453a;
  color: #ff453a;
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

/* Activity Module */
.activity-feed {
  padding: 24px;
  max-height: 400px;
  overflow-y: auto;
}

.activity-item {
  display: flex;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--border-color);
}

.activity-item:last-child {
  border-bottom: none;
}

.activity-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  font-size: 14px;
}

.activity-icon.federation {
  background: rgba(0, 212, 255, 0.1);
  color: #00d4ff;
}

.activity-icon.security {
  background: rgba(255, 193, 7, 0.1);
  color: #ffc107;
}

.activity-icon.moderation {
  background: rgba(255, 69, 58, 0.1);
  color: #ff453a;
}

.activity-content {
  flex: 1;
}

.activity-message {
  font-size: 14px;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.activity-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* Configuration Module */
.config-sections {
  padding: 24px;
}

.config-section {
  margin-bottom: 32px;
}

.config-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-primary);
}

.save-btn {
  padding: 8px 16px;
  background: var(--accent-color);
  border: none;
  border-radius: 6px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.save-btn:hover {
  background: #0099cc;
  transform: translateY(-1px);
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
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
  
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
  
  .add-block {
    flex-direction: column;
  }
  
  .user-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .user-actions {
    align-self: flex-end;
  }
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