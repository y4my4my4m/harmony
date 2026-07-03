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

      <!-- Federation Management -->
      <FederationManagement />

      <!-- User Management -->
      <UserManagement />

      <!-- Reports & Moderation -->
      <ReportsModeration />

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
          <div v-for="event in filteredRecentActivity" :key="event.id" class="activity-item">
            <div class="activity-icon" :class="getActivityCategory(event.type)">
              <Icon :name="getActivityIcon(event.type)" :size="16" />
            </div>
            <div class="activity-content">
              <div class="activity-message">{{ formatActivityMessage(event) }}</div>
              <div class="activity-meta">
                <span class="activity-time">{{ formatTime(event.timestamp) }}</span>
                <span class="activity-source">{{ event.source }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Announcements -->
      <div class="admin-module announcements-module">
        <div class="module-header">
          <Icon name="message-square" :size="20" />
          <h2>Announcements</h2>
          <button @click="showAnnouncementForm = true" class="primary-btn-sm">
            <Icon name="plus" :size="14" />
            Create
          </button>
        </div>
        <p class="module-hint">Instance-wide announcements shown to users. Create and manage them here.</p>
        <div v-if="showAnnouncementForm" class="announcement-form">
          <h4>{{ editingAnnouncementId ? 'Edit' : 'New' }} Announcement</h4>
          <div class="form-row">
            <label>Title</label>
            <input v-model="announcementForm.title" class="cyber-input" placeholder="Announcement title" />
          </div>
          <div class="form-row">
            <label>Content (supports basic HTML)</label>
            <textarea v-model="announcementForm.content" class="cyber-input" rows="4" placeholder="Announcement content"></textarea>
          </div>
          <div class="form-row">
            <label>Icon (emoji or name: info, warning, megaphone)</label>
            <input v-model="announcementForm.icon" class="cyber-input" placeholder="info" />
          </div>
          <div class="form-row">
            <label>Image URL (optional)</label>
            <input v-model="announcementForm.image_url" class="cyber-input" type="url" placeholder="https://..." />
          </div>
          <div class="form-row two-col">
            <div>
              <label>Starts at (optional)</label>
              <input
                v-model="announcementForm.starts_at"
                class="cyber-input"
                type="datetime-local"
              />
              <p class="form-hint">Leave empty to publish immediately. Times are interpreted in your local timezone.</p>
            </div>
            <div>
              <label>Ends at (optional)</label>
              <input
                v-model="announcementForm.ends_at"
                class="cyber-input"
                type="datetime-local"
                :min="announcementForm.starts_at || undefined"
              />
              <p class="form-hint">Leave empty for no expiration. After this time the announcement is hidden from users automatically.</p>
            </div>
          </div>
          <div class="form-row checks">
            <label class="toggle-label">
              <input type="checkbox" v-model="announcementForm.is_pinned" />
              <span class="toggle-slider"></span>
              <span class="toggle-text">Pinned</span>
            </label>
            <label class="toggle-label">
              <input type="checkbox" v-model="announcementForm.show_popup" />
              <span class="toggle-slider"></span>
              <span class="toggle-text">Show popup</span>
            </label>
            <label class="toggle-label" v-if="editingAnnouncementId">
              <input type="checkbox" v-model="announcementForm.is_active" />
              <span class="toggle-slider"></span>
              <span class="toggle-text">Active</span>
            </label>
          </div>
          <div class="form-actions">
            <button @click="saveAnnouncement" class="primary-btn-sm" :disabled="!announcementForm.title || !announcementForm.content">
              {{ editingAnnouncementId ? 'Update' : 'Create' }}
            </button>
            <button @click="cancelAnnouncementForm" class="cyber-btn-sm">Cancel</button>
          </div>
        </div>
        <div class="announcements-list">
          <div v-for="a in announcements" :key="a.id" class="announcement-item">
            <div class="announcement-meta">
              <span class="announcement-icon">{{ getAnnouncementIcon(a.icon) }}</span>
              <span class="announcement-title">{{ a.title }}</span>
              <span v-if="a.is_pinned" class="badge">Pinned</span>
              <span v-if="!a.is_active" class="badge inactive">Inactive</span>
            </div>
            <div class="announcement-actions">
              <button @click="editAnnouncement(a)" class="action-btn-sm" title="Edit">
                <Icon name="edit" :size="14" />
              </button>
              <button @click="deleteAnnouncement(a.id)" class="danger-btn-sm" title="Delete">
                <Icon name="trash" :size="14" />
              </button>
            </div>
          </div>
          <div v-if="announcements.length === 0 && !loadingStates.announcements" class="empty-state">
            No announcements. Create one to notify users.
          </div>
        </div>
      </div>

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
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import EmojiImporter from '@/components/admin/EmojiImporter.vue'
import PerformanceMonitoring from '@/components/admin/PerformanceMonitoring.vue'
import FederationManagement from '@/components/admin/FederationManagement.vue'
import UserManagement from '@/components/admin/UserManagement.vue'
import ReportsModeration from '@/components/admin/ReportsModeration.vue'
import InstanceConfig from '@/components/admin/InstanceConfig.vue'
import FundingSupporters from '@/components/admin/FundingSupporters.vue'
import { adminService, type AdminActivity } from '@/services/AdminService'
import { announcementService, type Announcement } from '@/services/AnnouncementService'
import { usePublicServersStore } from '@/stores/usePublicServers'
import { getServerIconUrl } from '@/utils/serverUtils'

const authStore = useAuthStore()
const router = useRouter()
const toast = useToast()

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
  window.addEventListener('admin:activity-changed', onActivityChanged)
})

const onActivityChanged = () => { void loadRecentActivity() }

// Reactive data
const loading = ref(false)
const activityFilter = ref('all')
const newBlockDomain = ref('')
const newBlockReason = ref('')



// Loading states
const loadingStates = ref({
  announcements: false,
  featuredServers: false,
})


// Announcements
const announcements = ref<Announcement[]>([])
const showAnnouncementForm = ref(false)
const editingAnnouncementId = ref<string | null>(null)
const announcementForm = ref({
  title: '',
  content: '',
  icon: 'info',
  image_url: '',
  is_pinned: false,
  show_popup: true,
  is_active: true,
  // datetime-local strings ("YYYY-MM-DDTHH:mm" in the admin's local TZ).
  // Empty string means "use the DB default" (now() for starts_at, NULL /
  // never-expires for ends_at). Converted to ISO at save time via
  // `localInputToIso` so PostgreSQL stores UTC.
  starts_at: '',
  ends_at: '',
})

// ---------------------------------------------------------------------------
// datetime-local <-> ISO helpers
// ---------------------------------------------------------------------------
// HTML's `datetime-local` input gives us a naive local timestamp without a
// timezone (e.g. "2026-05-26T21:00"). We convert in both directions so the
// admin sees their own timezone but the DB stores UTC ISO strings.
//
// Both helpers are intentionally null-safe and treat an empty input as "no
// value" rather than as the Unix epoch.
function localInputToIso(local: string): string | undefined {
  if (!local) return undefined
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString()
}

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // Shift by the local TZ offset so `toISOString().slice(0, 16)` formats
  // as the admin's wall-clock time rather than as UTC.
  const tzOffsetMs = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16)
}

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

// Users data
const blockedInstances = ref([
  { domain: 'bad-instance.com', reason: 'Spam and harassment' },
  { domain: 'another-bad.net', reason: 'Policy violations' }
])

const recentActivity = ref<any[]>([])

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

// Filter recent activity by category and format JSON details for display
const filteredRecentActivity = computed(() => {
  let list = recentActivity.value
  if (activityFilter.value !== 'all') {
    list = list.filter(e => getActivityCategory(e.type) === activityFilter.value)
  }
  return list
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
      loadRecentActivity(),
      loadAnnouncements(),
      loadFeaturedServers(),
    ])
  } catch (error) {
    debug.error('Failed to load admin data:', error)
  } finally {
    loading.value = false
  }
}

const loadAnnouncements = async () => {
  loadingStates.value.announcements = true
  try {
    announcements.value = await announcementService.getAllAnnouncements()
  } catch (error) {
    debug.error('Failed to load announcements:', error)
    announcements.value = []
  } finally {
    loadingStates.value.announcements = false
  }
}

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

const getAnnouncementIcon = (icon: string | undefined) => {
  if (!icon) return '📢'
  const icons: Record<string, string> = {
    info: 'ℹ️',
    warning: '⚠️',
    megaphone: '📢',
  }
  return icons[icon] || (icon.length <= 2 ? icon : '📢')
}

const saveAnnouncement = async () => {
  if (!announcementForm.value.title || !announcementForm.value.content) return

  // Asymmetric handling for the two timestamps:
  //   * `starts_at`: an empty input means "use the DB default (now()) on
  //     create" / "leave the existing value alone on update". Sending
  //     undefined makes the Supabase client omit the key entirely.
  //   * `ends_at`:   an empty input means "no expiration" - admins clearing
  //     the field must be able to explicitly drop the value back to NULL,
  //     otherwise an existing expiry would be impossible to remove. We
  //     send `null` rather than undefined so the column is overwritten.
  // Cross-field validation: end-before-start would silently produce an
  // announcement that's already expired the moment it's published.
  const startsIso = localInputToIso(announcementForm.value.starts_at)
  const endsIsoOrNull = announcementForm.value.ends_at
    ? localInputToIso(announcementForm.value.ends_at) ?? null
    : null
  if (startsIso && endsIsoOrNull && new Date(endsIsoOrNull) <= new Date(startsIso)) {
    toast.error('"Ends at" must be after "Starts at"')
    return
  }
  try {
    if (editingAnnouncementId.value) {
      await announcementService.updateAnnouncement(editingAnnouncementId.value, {
        title: announcementForm.value.title,
        content: announcementForm.value.content,
        icon: announcementForm.value.icon || 'info',
        image_url: announcementForm.value.image_url || undefined,
        is_pinned: announcementForm.value.is_pinned,
        show_popup: announcementForm.value.show_popup,
        is_active: announcementForm.value.is_active,
        starts_at: startsIso,
        ends_at: endsIsoOrNull,
      })
      toast.success('Announcement updated')
    } else {
      await announcementService.createAnnouncement({
        title: announcementForm.value.title,
        content: announcementForm.value.content,
        icon: announcementForm.value.icon || 'info',
        image_url: announcementForm.value.image_url || undefined,
        is_pinned: announcementForm.value.is_pinned,
        show_popup: announcementForm.value.show_popup,
        starts_at: startsIso,
        ends_at: endsIsoOrNull,
      })
      toast.success('Announcement created')
    }
    cancelAnnouncementForm()
    await loadAnnouncements()
  } catch (error: any) {
    debug.error('Failed to save announcement:', error)
    toast.error(error.message || 'Failed to save announcement')
  }
}

const cancelAnnouncementForm = () => {
  showAnnouncementForm.value = false
  editingAnnouncementId.value = null
  announcementForm.value = {
    title: '',
    content: '',
    icon: 'info',
    image_url: '',
    is_pinned: false,
    show_popup: true,
    is_active: true,
    starts_at: '',
    ends_at: '',
  }
}

const editAnnouncement = (a: Announcement) => {
  editingAnnouncementId.value = a.id
  announcementForm.value = {
    title: a.title,
    content: a.content,
    icon: a.icon || 'info',
    image_url: a.image_url || '',
    is_pinned: a.is_pinned ?? false,
    show_popup: a.show_popup ?? true,
    is_active: (a as any).is_active ?? true,
    // Convert the DB-stored UTC ISO back to the admin's local "YYYY-MM-DDTHH:mm"
    // so the datetime-local inputs render the wall-clock time they originally
    // entered, not UTC. Empty when unset.
    starts_at: isoToLocalInput((a as any).starts_at),
    ends_at: isoToLocalInput(a.ends_at),
  }
  showAnnouncementForm.value = true
}

const deleteAnnouncement = async (id: string) => {
  if (!confirm('Delete this announcement?')) return
  try {
    await announcementService.deleteAnnouncement(id)
    toast.success('Announcement deleted')
    await loadAnnouncements()
  } catch (error: any) {
    debug.error('Failed to delete announcement:', error)
    toast.error(error.message || 'Failed to delete')
  }
}

const loadRecentActivity = async () => {
  try {
    const activity = await adminService.getRecentActivity(20)
    
    recentActivity.value = activity.map((event: AdminActivity) => ({
      id: event.id,
      type: event.action_type,
      message: event.details,
      targetUsername: event.target_username,
      timestamp: new Date(event.created_at),
      source: `Admin: ${event.admin_username}`,
      admin_id: event.admin_id
    }))
  } catch (error) {
    debug.error('Failed to load recent activity:', error)
    recentActivity.value = []
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

// eslint-disable-next-line unused-imports/no-unused-vars
const blockInstance = async () => {
  if (newBlockDomain.value && newBlockReason.value) {
    try {
      await adminService.moderateInstance(
        newBlockDomain.value,
        'block',
        newBlockReason.value,
        authStore.session?.user?.id || ''
      )

      blockedInstances.value.push({
        domain: newBlockDomain.value,
        reason: newBlockReason.value
      })
      
      newBlockDomain.value = ''
      newBlockReason.value = ''
      
      // Refresh activity log
      await loadRecentActivity()
    } catch (error) {
      debug.error('Failed to block instance:', error)
      alert('Failed to block instance. Check console for details.')
    }
  }
}

// eslint-disable-next-line unused-imports/no-unused-vars
const unblockInstance = async (domain: string) => {
  try {
    await adminService.moderateInstance(
      domain,
      'unblock',
      'Admin unblock',
      authStore.session?.user?.id || ''
    )

    const index = blockedInstances.value.findIndex(i => i.domain === domain)
    if (index !== -1) {
      blockedInstances.value.splice(index, 1)
    }
    
    // Refresh activity log
    await loadRecentActivity()
  } catch (error) {
    debug.error('Failed to unblock instance:', error)
    alert('Failed to unblock instance. Check console for details.')
  }
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

const formatTime = (date: Date) => {
  return date.toLocaleTimeString()
}

const getActivityCategory = (type: string): string => {
  if (!type) return 'other'
  const t = type.toLowerCase()
  if (t.startsWith('instance_') || t.includes('federation') || t.includes('add_instance')) return 'federation'
  if (t.startsWith('user_') || t.includes('moderate') || t.includes('report') || t.includes('suspend')) return 'moderation'
  if (t.includes('security') || t.includes('login') || t.includes('config')) return 'security'
  return 'other'
}

const CONFIG_KEY_LABELS: Record<string, string> = {
  instance_name: 'Instance name',
  instance_description: 'Instance description',
  terms_url: 'Terms URL',
  privacy_url: 'Privacy URL',
  max_post_length: 'Max post length',
  max_server_size: 'Max server size',
  max_message_length: 'Max message length',
  max_custom_emojis_per_server: 'Max custom emojis per server',
  custom_emoji_transform_quality: 'Custom emoji image quality',
  allow_file_uploads: 'Allow file uploads',
  enable_voice_channels: 'Enable voice channels',
  federation_retry_attempts: 'Federation retry attempts',
  oauth_providers: 'OAuth providers'
}

const formatConfigValue = (v: unknown): string => {
  if (v == null || (typeof v === 'string' && v === '')) return '(empty)'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const formatActivityMessage = (event: { type: string; message: string | object; targetUsername?: string }) => {
  const raw = event.message
  const targetUser = event.targetUsername
  if (raw == null || raw === '') {
    if (event.type?.startsWith('user_') && targetUser) {
      const verb = event.type === 'user_suspend' ? 'Suspended' : event.type === 'user_delete' ? 'Deleted' : event.type === 'user_unsuspend' ? 'Unsuspended' : event.type
      return `${verb} @${targetUser}`
    }
    return event.type || 'Event'
  }
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof obj !== 'object' || obj === null) return String(raw)

    // Config change: key, new_value, old_value
    if (obj.key != null && ('new_value' in obj || 'old_value' in obj)) {
      const label = CONFIG_KEY_LABELS[obj.key] || obj.key.replace(/_/g, ' ')
      const newVal = formatConfigValue(obj.new_value)
      const oldVal = formatConfigValue(obj.old_value)
      if (oldVal !== '(empty)' && newVal !== oldVal) {
        return `${label}: ${newVal} (was ${oldVal})`
      }
      return `${label}: ${newVal}`
    }

    // User moderation with target
    if ((event.type?.startsWith('user_') || obj.action === 'suspend' || obj.action === 'delete' || obj.action === 'unsuspend') && (targetUser || obj.user_id)) {
      const who = targetUser ? `@${targetUser}` : (obj.user_id ? `user ${String(obj.user_id).slice(0, 8)}...` : '')
      const reason = obj.reason ? ` - ${obj.reason}` : ''
      const verb = event.type === 'user_suspend' ? 'Suspended' : event.type === 'user_delete' ? 'Deleted' : event.type === 'user_unsuspend' ? 'Unsuspended' : ''
      return `${verb || 'Moderated'} ${who}${reason}`.trim()
    }

    // Build human-readable message from common keys
    const parts: string[] = []
    if (obj.domain) parts.push(obj.domain)
    if (obj.reason) parts.push(`- ${obj.reason}`)
    if (obj.action) parts.push(`(${obj.action})`)
    if (obj.user_id && !targetUser) parts.push(`user: ${obj.user_id}`)
    if (targetUser) parts.unshift(`@${targetUser}`)
    if (parts.length) return parts.join(' ')

    // Fallback: format key-value pairs
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(', ')
  } catch {
    return typeof raw === 'string' ? raw : String(raw)
  }
}

const getActivityIcon = (type: string) => {
  const cat = getActivityCategory(type)
  switch (cat) {
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







.activity-icon.other {
  background: rgba(128, 128, 128, 0.1);
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






.announcement-form {
  margin: 0 24px 20px;
  padding: 20px;
  background: var(--background-tertiary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}






.announcement-form h4 { margin: 0 0 16px 0; }






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






.announcements-list { padding: 0 24px 24px; }






.announcement-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border-radius: 8px;
  margin-bottom: 8px;
  border: 1px solid var(--border-color);
}






.announcement-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }






.announcement-icon { font-size: 18px; }






.announcement-title { font-weight: 600; color: var(--text-primary); }






.announcement-item .badge.inactive { background: var(--background-quaternary); color: var(--text-muted); }






.announcement-actions { display: flex; gap: 4px; }







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