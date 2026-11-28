<template>
  <div class="admin-panel">
    <div class="admin-header">
      <div class="admin-title">
        <button
          v-if="isMobile"
          type="button"
          class="nav-menu-btn"
          :aria-label="t('activitypub.openNavigation')"
          @click="openLeftSidebar"
        >
          <Icon name="menu" :size="20" />
        </button>
        <Icon name="admin-terminal" :size="24" />
        <h1>{{ isAdmin ? t('admin.panel.title') : t('admin.panel.moderationTitle') }}</h1>
        <div v-if="isAdmin" class="system-status" :class="systemStatus.class">
          <div class="status-indicator"></div>
          <span>{{ t(systemStatus.text) }}</span>
        </div>
      </div>
      <div v-if="isAdmin" class="admin-actions">
        <button @click="refreshData" class="action-btn refresh-btn" :disabled="loading">
          <Icon name="refresh" :size="16" />
          {{ t('admin.emojis.refresh') }}
        </button>
      </div>
    </div>

    <nav class="admin-tabs" role="tablist">
      <button
        v-for="tab in visibleTabs"
        :key="tab.key"
        role="tab"
        :aria-selected="activeAdminTab === tab.key"
        :class="['admin-tab-btn', { active: activeAdminTab === tab.key }]"
        @click="activeAdminTab = tab.key"
      >
        <Icon :name="tab.icon" :size="15" />
        {{ t(tab.label) }}<template v-if="tab.key === 'reports' && instancePending > 0">
          <span class="report-count-badge" aria-hidden="true" data-testid="admin-tab-reports-badge">{{ badgeCount(instancePending) }}</span>
          <span class="sr-only">, {{ t('moderation.reportAlert.pendingA11y', { count: instancePending }, instancePending) }}</span>
        </template>
      </button>
    </nav>

    <div v-if="activeAdminTab === 'overview'" class="admin-grid">
      <!-- System Overview -->
      <div class="admin-module overview-module">
        <div class="module-header">
          <Icon name="dashboard" :size="20" />
          <h2>{{ t('admin.panel.overviewTitle') }}</h2>
          <span v-if="updatedText" class="snapshot-age" data-testid="admin-stats-updated">{{ updatedText }}</span>
        </div>
        <div class="stats-grid">
          <div v-for="card in statCards" :key="card.key" class="stat-card">
            <div class="stat-icon">
              <Icon :name="card.icon" :size="24" />
            </div>
            <div class="stat-content">
              <div class="stat-value" :data-testid="`admin-stat-${card.key}`">
                <span v-if="card.approximate" class="approx-mark" :title="t('admin.panel.approximate')"><span aria-hidden="true">≈</span><span class="sr-only">{{ `${t('admin.panel.approximately')} ` }}</span></span>{{ formatNumber(card.value) }}
              </div>
              <div class="stat-label">{{ t(card.label) }}</div>
              <div v-if="card.change" class="stat-change" :class="{ positive: card.key === 'users' }">{{ card.change }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- System Health -->
      <div class="admin-module health-module">
        <div class="module-header">
          <Icon name="health" :size="20" />
          <h2>{{ t('admin.panel.healthTitle') }}</h2>
          <div class="health-indicator" :class="healthStatus.class">
            {{ t(healthStatus.text) }}
          </div>
        </div>
        <div class="health-metrics">
          <div class="metric-card">
            <div class="metric-header">
              <span>{{ t('admin.panel.database') }}</span>
            </div>
            <div class="metric-value" data-testid="admin-db-response">{{ stats ? t('admin.panel.responseMs', { ms: stats.responseMs }) : '—' }}</div>
            <div class="metric-detail">{{ t('admin.panel.connections', { count: stats?.database?.connections ?? 0 }, stats?.database?.connections ?? 0) }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-header">
              <span>{{ t('admin.panel.federationQueue') }}</span>
              <div class="metric-status" :class="queueStatus"></div>
            </div>
            <div class="metric-value">
              <span v-if="isApproximate('queue_pending')" class="approx-mark" :title="t('admin.panel.approximate')"><span aria-hidden="true">≈</span><span class="sr-only">{{ `${t('admin.panel.approximately')} ` }}</span></span>{{ stats?.queue?.pending ?? 0 }}
            </div>
            <div class="metric-detail">{{ t('admin.panel.pendingDeliveries') }}</div>
          </div>
          <div class="metric-card">
            <div class="metric-header">
              <span>{{ t('admin.panel.databaseSize') }}</span>
            </div>
            <div class="metric-value" data-testid="admin-db-size">{{ stats?.database ? formatBytes(stats.database.sizeBytes) : '—' }}</div>
            <div class="metric-detail">{{ t('admin.panel.totalSize') }}</div>
          </div>
        </div>
      </div>

      <!-- Recent Activity -->
      <ActivityLog />
    </div>

    <div v-else-if="activeAdminTab === 'federation'" class="admin-grid single">
      <FederationManagement />
      <RemoteServersAdmin />
    </div>

    <div v-else-if="activeAdminTab === 'users'" class="admin-grid single">
      <UserManagement />
    </div>

    <div v-else-if="activeAdminTab === 'signups'" class="admin-grid single">
      <RecentSignups />
    </div>

    <div v-else-if="activeAdminTab === 'invites'" class="admin-grid single">
      <InstanceInvites />
      <SignupProviders v-if="hasCapability('signup-methods')" />
      <SignupLimits v-if="hasCapability('signup-limits')" />
      <SignupCaptchaSettings v-if="hasCapability('signup-captcha')" />
    </div>

    <div v-else-if="activeAdminTab === 'retention'" class="admin-grid single">
      <RetentionCohorts />
    </div>

    <div v-else-if="activeAdminTab === 'reports'" class="admin-grid single">
      <ReportsModeration />
    </div>

    <div v-else-if="activeAdminTab === 'servers'" class="admin-grid single">
      <HostedServersAdmin />
    </div>

    <div v-else-if="activeAdminTab === 'antispam'" class="admin-grid single">
      <AntiSpamAdmin />
    </div>

    <div v-else-if="activeAdminTab === 'activities'" class="admin-grid single">
      <ActivitiesAdmin />
    </div>
    <div v-else-if="activeAdminTab === 'webhooks'" class="admin-grid single">
      <WebhooksAdmin />
    </div>

    <div v-else-if="activeAdminTab === 'content'" class="admin-grid">
      <AnnouncementsAdmin />
      <WelcomeServerAdmin />
      <FeaturedCommunities />
    </div>

    <div v-else-if="activeAdminTab === 'config'" class="admin-grid single">
      <InstanceConfig />
    </div>

    <div v-else-if="activeAdminTab === 'funding'" class="admin-grid single">
      <FundingSupporters />
    </div>

    <div v-else-if="activeAdminTab === 'drive'" class="admin-grid single">
      <DriveAdmin />
    </div>

    <div v-else-if="activeAdminTab === 'emojis'" class="admin-grid single">
      <AdminEmojiLibrary />
    </div>

    <div v-else-if="activeAdminTab === 'stickers'" class="admin-grid single">
      <StickerSettings
        scope="instance"
        variant="module"
        can-manage
        :title="t('stickers.manage.instanceTitle')"
        :description="t('stickers.manage.instanceDescription')"
      />
    </div>

    <div v-else-if="activeAdminTab === 'tools'" class="admin-grid">
      <!-- Performance Monitoring -->
      <div class="admin-module performance-module">
        <div class="module-header">
          <Icon name="activity" :size="20" />
          <h2>{{ t('admin.panel.performanceTitle') }}</h2>
        </div>
        <div class="performance-content">
          <PerformanceMonitoring />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, defineAsyncComponent } from 'vue'
import { badgeCount, refreshInstancePendingReports, useReportQueueCounts } from '@/composables/useReportQueueCounts'
import { hasCapability } from '@/services/instanceCapabilities'
import { useAuthStore } from '@/stores/auth'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { useLayoutState } from '@/composables/useLayoutState'
import ActivityLog from '@/components/admin/ActivityLog.vue'

// Modules load lazily per tab so opening the panel only fetches Overview.
const AdminEmojiLibrary = defineAsyncComponent(() => import('@/components/admin/AdminEmojiLibrary.vue'))
const PerformanceMonitoring = defineAsyncComponent(() => import('@/components/admin/PerformanceMonitoring.vue'))
const FederationManagement = defineAsyncComponent(() => import('@/components/admin/FederationManagement.vue'))
const RemoteServersAdmin = defineAsyncComponent(() => import('@/components/admin/RemoteServersAdmin.vue'))
const UserManagement = defineAsyncComponent(() => import('@/components/admin/UserManagement.vue'))
const RecentSignups = defineAsyncComponent(() => import('@/components/admin/RecentSignups.vue'))
const InstanceInvites = defineAsyncComponent(() => import('@/components/admin/InstanceInvites.vue'))
const SignupLimits = defineAsyncComponent(() => import('@/components/admin/SignupLimits.vue'))
const SignupProviders = defineAsyncComponent(() => import('@/components/admin/SignupProviders.vue'))
const SignupCaptchaSettings = defineAsyncComponent(() => import('@/components/admin/SignupCaptchaSettings.vue'))
const RetentionCohorts = defineAsyncComponent(() => import('@/components/admin/RetentionCohorts.vue'))
const ReportsModeration = defineAsyncComponent(() => import('@/components/admin/ReportsModeration.vue'))
const HostedServersAdmin = defineAsyncComponent(() => import('@/components/admin/HostedServersAdmin.vue'))
const AntiSpamAdmin = defineAsyncComponent(() => import('@/components/admin/AntiSpamAdmin.vue'))
const WebhooksAdmin = defineAsyncComponent(() => import('@/components/admin/WebhooksAdmin.vue'))
const ActivitiesAdmin = defineAsyncComponent(() => import('@/components/admin/ActivitiesAdmin.vue'))
const AnnouncementsAdmin = defineAsyncComponent(() => import('@/components/admin/AnnouncementsAdmin.vue'))
const FeaturedCommunities = defineAsyncComponent(() => import('@/components/admin/FeaturedCommunities.vue'))
const WelcomeServerAdmin = defineAsyncComponent(() => import('@/components/admin/WelcomeServerAdmin.vue'))
const InstanceConfig = defineAsyncComponent(() => import('@/components/admin/InstanceConfig.vue'))
const FundingSupporters = defineAsyncComponent(() => import('@/components/admin/FundingSupporters.vue'))
const DriveAdmin = defineAsyncComponent(() => import('@/components/admin/DriveAdmin.vue'))
const StickerSettings = defineAsyncComponent(() => import('@/components/stickers/StickerSettings.vue'))
import { adminService } from '@/services/AdminService'
import { useInstanceStats } from '@/composables/useInstanceStats'
import { formatAge, formatNumber } from '@/components/admin/adminFormat'
import { formatBytes } from '@/components/drive/driveFormat'
import { useProfileStore } from '@/stores/useProfile'


const authStore = useAuthStore()
const router = useRouter()
const route = useRoute()
const { isMobile, openLeftSidebar } = useLayoutState()
const { t } = useI18n()

const adminTabs = [
  { key: 'overview', label: 'admin.panel.tabs.overview', icon: 'dashboard' },
  { key: 'federation', label: 'admin.panel.tabs.federation', icon: 'federation' },
  { key: 'users', label: 'admin.panel.tabs.users', icon: 'users' },
  { key: 'signups', label: 'adminSignups.tab', icon: 'user-plus' },
  { key: 'invites', label: 'adminInvites.tab', icon: 'user-plus' },
  { key: 'retention', label: 'adminRetention.tab', icon: 'trending-up' },
  { key: 'reports', label: 'admin.panel.tabs.reports', icon: 'flag' },
  { key: 'servers', label: 'hostStaff.tab', icon: 'server' },
  { key: 'antispam', label: 'admin.antiSpam.title', icon: 'shield' },
  { key: 'webhooks', label: 'adminWebhooks.tab', icon: 'link' },
  { key: 'activities', label: 'playTogether.admin.tab', icon: 'gamepad' },
  { key: 'content', label: 'admin.panel.tabs.content', icon: 'megaphone' },
  { key: 'emojis', label: 'admin.instanceEmojis.tab', icon: 'emoji' },
  { key: 'stickers', label: 'stickers.manage.navLabel', icon: 'sticker' },
  { key: 'config', label: 'admin.panel.tabs.config', icon: 'settings' },
  { key: 'funding', label: 'admin.panel.tabs.funding', icon: 'heart' },
  { key: 'drive', label: 'drive.title', icon: 'hard-drive' },
  { key: 'tools', label: 'admin.panel.tabs.tools', icon: 'wrench' },
] as const
type AdminTabKey = typeof adminTabs[number]['key']

const profileStore = useProfileStore()
const isAdmin = computed(() => profileStore.profile?.is_admin === true)
// Instance moderators: reports, account actions, signup review, servers hosted here, the anti-spam
// queue, outgoing webhooks (switching one off), federation read-only.
const MODERATOR_TABS: readonly AdminTabKey[] = ['federation', 'users', 'signups', 'reports', 'servers', 'antispam', 'webhooks']
const visibleTabs = computed(() =>
  (isAdmin.value ? adminTabs : adminTabs.filter(tab => MODERATOR_TABS.includes(tab.key)))
    .filter(tab => tab.key !== 'webhooks' || hasCapability('outgoing-webhooks'))
    .filter(tab => tab.key !== 'stickers' || hasCapability('custom-stickers'))
    .filter(tab => tab.key !== 'invites' || hasCapability('instance-invites'))
    .filter(tab => tab.key !== 'signups' || hasCapability('signup-review')))

const requestedTab = visibleTabs.value.find(t => t.key === route.query.tab)?.key
const activeAdminTab = ref<AdminTabKey>(requestedTab ?? (isAdmin.value ? 'overview' : 'reports'))
watch(activeAdminTab, (tab) => {
  router.replace({ query: { ...route.query, tab: tab === 'overview' ? undefined : tab } }).catch(() => {})
})
// A link to another tab changes the query alone.
watch(() => route.query.tab, (tab) => {
  const next = visibleTabs.value.find(t => t.key === tab)?.key
  if (next) activeAdminTab.value = next
})

// Instance staff only; the overview's data is admin-only.
const { instancePending } = useReportQueueCounts()

onMounted(async () => {
  void refreshInstancePendingReports()
  if (!authStore.session?.user?.id) {
    router.push('/login')
    return
  }

  const isStaff = await adminService.checkAdminOrModPermissions(authStore.session.user.id)

  if (!isStaff) {
    router.push('/')
    return
  }

  if (isAdmin.value && activeAdminTab.value === 'overview') await loadInitialData()
})

const { stats, loading, failed, ageSeconds, load: loadStats } = useInstanceStats()

const isApproximate = (column: string) => stats.value?.approximate.includes(column) === true

const statCards = computed(() => {
  const s = stats.value
  return [
    { key: 'users', icon: 'users', label: 'admin.panel.stats.users', value: s?.users.total, approximate: isApproximate('users_total'),
      change: t('admin.panel.stats.newLast24h', { count: formatNumber(s?.users.new24h) }) },
    { key: 'servers', icon: 'server', label: 'admin.panel.stats.servers', value: s?.servers.total, approximate: isApproximate('servers_total'),
      change: t('admin.panel.stats.activeLast30d', { count: formatNumber(s?.servers.active30d) }) },
    { key: 'instances', icon: 'federation', label: 'admin.panel.stats.instances', value: s?.instances.total, approximate: false,
      change: '' },
    { key: 'posts', icon: 'message', label: 'admin.panel.stats.posts', value: s?.posts.total, approximate: isApproximate('posts_total'),
      change: t('admin.panel.stats.newLast24h', { count: formatNumber(s?.posts.last24h) }) },
  ]
})

const updatedText = computed(() => {
  if (!stats.value) return ''
  if (stats.value.computedAt === null) return stats.value.refreshingElsewhere ? t('admin.panel.updating') : ''
  return t('admin.panel.updated', { age: formatAge(ageSeconds.value ?? 0) })
})

const queueStatus = computed(() => (stats.value?.queue?.pending ?? 0) > 100 ? 'warning' : 'healthy')

const systemStatus = computed(() =>
  failed.value
    ? { class: 'error', text: 'admin.panel.statsUnavailable' }
    : { class: 'healthy', text: 'admin.panel.allOperational' })

const healthStatus = computed(() =>
  failed.value ? { class: 'error', text: 'admin.panel.unavailable' } : { class: 'healthy', text: 'admin.panel.healthy' })

const loadInitialData = () => loadStats(false)

// The snapshot is read where it shows: Overview here, the Federation tab in its module.
watch(activeAdminTab, (tab) => {
  if (tab === 'overview' && isAdmin.value) void loadInitialData()
})

const refreshData = () => loadStats(true)

</script>

<style scoped>
.admin-panel {
  padding: 24px;
  background: var(--background-primary);
  min-height: calc(100 * var(--app-vh));
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

/* The page has no header of the social or chat layouts; on mobile this is the
   way to the navigation drawer besides the edge swipe. */
.nav-menu-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
}

.nav-menu-btn:hover {
  background: var(--background-modifier-hover);
}









.admin-title h1 {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  margin: 0;
  color: var(--text-primary);
}









.system-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-radius: var(--radius-full);
  font-size: 12px;
  font-weight: 600;
}









.system-status.healthy {
  background: color-mix(in srgb, var(--success) 10%, transparent);
  color: var(--text-success);
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
}









.system-status.warning {
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  color: var(--warning);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
}









.system-status.error {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--text-danger);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
}









.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
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
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}









.action-btn:hover {
  background: var(--background-tertiary);
  border-color: var(--harmony-primary);
}









.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.report-count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--error-fill);
  color: var(--text-on-primary);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}

.admin-tab-btn:hover {
  color: var(--text-primary);
  border-color: var(--harmony-primary);
}

.admin-tab-btn.active {
  color: var(--text-link);
  border-color: var(--harmony-primary);
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
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
  border-radius: var(--radius-lg);
  overflow: hidden;
  min-width: 0;
}


















.module-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}









.module-header h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
  flex: 1;
}

.snapshot-age {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.approx-mark {
  margin-right: 2px;
  color: var(--text-secondary);
  font-weight: 600;
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
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}


















.stat-icon {
  padding: 12px;
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  border-radius: var(--radius-md);
  color: var(--text-link);
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
  color: var(--text-success);
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
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: 14px;
  transition: all 0.2s ease;
}









.cyber-input:focus, .cyber-textarea:focus, .cyber-select:focus {
  outline: none;
  border-color: var(--harmony-primary);
  box-shadow: 0 0 0 2px var(--harmony-primary-alpha-strong);
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
  border-radius: var(--radius-full);
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
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
}









.toggle-label input[type="checkbox"]:checked + .toggle-slider:before {
  left: 22px;
  background: var(--text-on-primary);
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
  border: 1px solid color-mix(in srgb, var(--error) 20%, transparent);
  border-radius: var(--radius-md);
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
  background: color-mix(in srgb, var(--error) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
  border-radius: var(--radius-base);
  color: var(--text-danger);
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
  background: var(--harmony-primary-fill);
  border: none;
  border-radius: var(--radius-base);
  color: var(--text-on-primary);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}









.primary-btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}









.primary-btn:hover, .primary-btn-sm:hover {
  background: var(--harmony-primary-fill-hover);
}









.spinner-small {
  width: 14px;
  height: 14px;
  border: 2px solid color-mix(in srgb, var(--error) 30%, transparent);
  border-top-color: var(--error);
  border-radius: 50%;
  display: inline-block;
  animation: spin 0.8s linear infinite;
}










































.spin {
  animation: spin 1s linear infinite;
}









@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}









.error-text {
  color: var(--text-danger);
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
  border-radius: var(--radius-full);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}









.badge.trusted {
  background: color-mix(in srgb, var(--success) 20%, transparent);
  color: var(--text-success);
}









.badge.blocked {
  background: color-mix(in srgb, var(--error) 20%, transparent);
  color: var(--text-danger);
}









.badge.inactive {
  background: var(--background-modifier-active);
  color: var(--text-muted);
}









.badge.success {
  background: color-mix(in srgb, var(--success) 20%, transparent);
  color: var(--text-success);
}









.badge.info {
  background: color-mix(in srgb, var(--info) 20%, transparent);
  color: var(--info);
}









.detail-item {
  white-space: nowrap;
}









.action-btn-sm, .danger-btn-sm {
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--background-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}









.action-btn-sm:hover {
  border-color: var(--harmony-primary);
  color: var(--text-link);
}









.action-btn-sm.trusted {
  border-color: color-mix(in srgb, var(--success) 50%, transparent);
  color: var(--text-success);
}









.danger-btn-sm:hover {
  border-color: color-mix(in srgb, var(--error) 50%, transparent);
  color: var(--text-danger);
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
  border-radius: var(--radius-base);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}









.pagination-btn:hover:not(:disabled) {
  border-color: var(--harmony-primary);
  color: var(--text-link);
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
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}









.tab-btn.active {
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
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
  border-radius: var(--radius-sm);
  font-weight: 600;
  text-transform: uppercase;
}









.badge.suspended {
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--warning);
}









.badge.admin {
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  color: var(--text-link);
}









.badge.moderator {
  background: color-mix(in srgb, var(--success) 20%, transparent);
  color: var(--text-success);
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
  border-radius: var(--radius-md);
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
  background: var(--success);
}









.metric-status.warning {
  background: var(--warning);
}









.metric-status.error {
  background: var(--error);
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
  color: var(--text-muted);
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
  border-radius: var(--radius-md);
  border: 1px solid var(--border-color);
  transition: all 0.2s ease;
}








.featured-server-item:hover { border-color: var(--harmony-primary); }








.featured-server-item.featured {
  border-color: color-mix(in srgb, var(--warning) 50%, transparent);
  background: color-mix(in srgb, var(--warning) 5%, transparent);
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
  border-radius: var(--radius-md);
  object-fit: cover;
}








.featured-badge {
  position: absolute;
  bottom: -4px;
  right: -4px;
  color: var(--text-link);
  background: var(--background-secondary);
  border-radius: 50%;
  padding: 2px;
}








.server-details { flex: 1; min-width: 0; }








.server-details .server-name { font-weight: 600; color: var(--text-primary); }








.server-details .server-meta { font-size: 13px; color: var(--text-secondary); }








.featured-server-item .action-btn-sm.pin-btn { color: var(--text-link); }








.featured-server-item .action-btn-sm.unpin-btn { color: var(--text-secondary); }








.featured-server-item .action-btn-sm { display: flex; align-items: center; gap: 6px; }


















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
  border-radius: var(--radius-base) var(--radius-base) 0 0;
}









.config-tab-btn.active {
  color: var(--text-link);
  border-bottom-color: var(--harmony-primary);
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
    max-width: calc(100 * var(--app-vw) - 32px);
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
    flex-wrap: wrap;
    gap: 8px;
  }

  .admin-tab-btn {
    min-height: 40px;
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
    max-width: calc(100 * var(--app-vw) - 24px);
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
  border-radius: var(--radius-lg);
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
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--warning);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font-weight: 600;
  text-transform: uppercase;
}









.server-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}









.report-type-badge.user { background: var(--background-modifier-active); color: var(--text-secondary); }








.report-type-badge.post { background: var(--background-modifier-active); color: var(--text-secondary); }








.report-type-badge.message { background: var(--background-modifier-active); color: var(--text-secondary); }








.report-type-badge.server { background: var(--background-modifier-active); color: var(--text-secondary); }









.report-proof :deep(.report-link) {
  color: var(--text-link);
  text-decoration: underline;
  word-break: break-all;
}









.report-proof :deep(.report-link:hover) {
  opacity: 0.8;
}









.report-action-btn.investigating {
  background: color-mix(in srgb, var(--info) 30%, transparent);
  color: var(--info);
}









.badge.sensitive {
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--warning);
}









.badge.cw {
  background: color-mix(in srgb, var(--info) 20%, transparent);
  color: var(--info);
}









.badge.silenced {
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--warning);
}









.mod-btn.warning-btn {
  background: color-mix(in srgb, var(--warning) 15%, transparent);
  color: var(--warning);
}









.mod-btn.warning-btn:hover {
  background: color-mix(in srgb, var(--warning) 30%, transparent);
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
  color: color-mix(in srgb, var(--text-on-primary) 60%, transparent);
}









</style> 