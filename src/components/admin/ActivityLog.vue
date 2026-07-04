<template>
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

</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'
import Icon from '@/components/common/Icon.vue'
import { adminService, type AdminActivity } from '@/services/AdminService'




const activityFilter = ref('all')
const recentActivity = ref<any[]>([])

const filteredRecentActivity = computed(() => {
  let list = recentActivity.value
  if (activityFilter.value !== 'all') {
    list = list.filter(e => getActivityCategory(e.type) === activityFilter.value)
  }
  return list
})


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

const onActivityChanged = () => { void loadRecentActivity() }
onMounted(() => {
  void loadRecentActivity()
  window.addEventListener('admin:activity-changed', onActivityChanged)
})
onUnmounted(() => window.removeEventListener('admin:activity-changed', onActivityChanged))
</script>

<style scoped>








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
</style>

<style scoped src="./adminShared.css"></style>
