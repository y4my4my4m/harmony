<template>
<!-- Reports & Moderation -->
<div class="admin-module reports-module">
  <div class="module-header">
    <Icon name="flag" :size="20" />
    <h2>Reports & Moderation</h2>
    <span v-if="pendingReportsCount > 0" class="reports-badge">{{ pendingReportsCount }} pending</span>
  </div>

  <div class="report-filters">
    <button
      v-for="filter in reportFilters"
      :key="filter.key"
      @click="activeReportFilter = filter.key"
      :class="['filter-btn', { active: activeReportFilter === filter.key }]"
    >
      {{ filter.label }}
    </button>
  </div>

  <div class="reports-list" v-if="reports.length > 0">
    <div
      v-for="report in reports"
      :key="report.id"
      class="report-item"
      :class="{ expanded: expandedReportId === report.id }"
      @click="toggleReportExpand(report.id)"
    >
      <div class="report-summary">
        <div class="report-type-badge" :class="report.report_type">
          {{ report.report_type }}
        </div>
        <div class="report-users">
          <div class="report-reporter">
            <Avatar :src="report.reporter_avatar_url" :alt="report.reporter_username" size="xs" />
            <span class="report-user-link" @click.stop="navigateToReportUser(report, 'reporter')">
              <DisplayName v-if="report.reporter_id" :user-id="(report.reporter_id ?? undefined)" :fallback="(report.reporter_display_name || report.reporter_username) ?? undefined" />
              <template v-else>{{ report.reporter_display_name || report.reporter_username }}</template>
              <span v-if="!report.reporter_is_local && report.reporter_domain" class="federation-badge" title="Federated user">
                @{{ report.reporter_domain }}
              </span>
            </span>
          </div>
          <span class="report-arrow">&#8594;</span>
          <div class="report-reported" v-if="report.reported_user_id || report.reported_user_username">
            <Avatar :src="report.reported_user_avatar_url" :alt="report.reported_user_username ?? undefined" size="xs" />
            <span class="report-user-link" @click.stop="navigateToReportUser(report, 'reported')">
              <DisplayName v-if="report.reported_user_id" :user-id="(report.reported_user_id ?? undefined)" :fallback="(report.reported_user_display_name || report.reported_user_username) ?? undefined" />
              <template v-else>{{ report.reported_user_display_name || report.reported_user_username }}</template>
              <span v-if="!report.reported_user_is_local && report.reported_user_domain" class="federation-badge" title="Federated user">
                @{{ report.reported_user_domain }}
              </span>
            </span>
            <a
              v-if="!report.reported_user_is_local && report.reported_user_domain"
              :href="`https://${report.reported_user_domain}/@${report.reported_user_username}`"
              target="_blank"
              rel="noopener noreferrer"
              class="report-external-link"
              title="View on remote instance"
              @click.stop
            >
              <Icon name="external-link" :size="14" />
            </a>
          </div>
        </div>
        <div class="report-reason">{{ report.reason }}</div>
        <div class="report-meta">
          <span v-if="report.source !== 'local'" class="report-source federation-badge">{{ report.source_instance || report.source }}</span>
          <span v-else class="report-source-local">local</span>
          <time class="report-time">{{ formatDate(report.created_at) }}</time>
        </div>
        <div class="report-status-badge" :class="report.status">{{ report.status }}</div>
      </div>

      <div v-if="expandedReportId === report.id" class="report-detail" @click.stop>
        <div v-if="report.comment" class="report-comment">
          <label>Reporter's comment</label>
          <p>{{ report.comment }}</p>
        </div>

        <div v-if="report.reported_message_preview" class="report-proof">
          <label>Reported message</label>
          <blockquote v-html="linkifyReportPreview(report.reported_message_preview)"></blockquote>
        </div>

        <div v-if="report.reported_post_preview" class="report-proof">
          <label>Reported post</label>
          <blockquote v-html="linkifyReportPreview(report.reported_post_preview)"></blockquote>
          <div class="report-post-meta">
            <span v-if="report.reported_post_is_sensitive" class="badge sensitive">Sensitive</span>
            <span v-if="report.reported_post_content_warning" class="badge cw">CW: {{ report.reported_post_content_warning }}</span>
          </div>
          <div class="report-post-links">
            <button
              v-if="report.reported_post_id"
              class="report-link-btn"
              @click.stop="navigateToPost(report.reported_post_id!)"
            >
              <Icon name="eye" :size="14" /> View post
            </button>
            <a
              v-if="report.reported_post_url || report.reported_post_ap_id"
              :href="report.reported_post_url || report.reported_post_ap_id!"
              target="_blank"
              rel="noopener noreferrer"
              class="report-link-btn"
              @click.stop
            >
              <Icon name="external-link" :size="14" /> View on remote instance
            </a>
          </div>
        </div>

        <div v-if="report.resolution_note" class="report-resolution">
          <label>Resolution note</label>
          <p>{{ report.resolution_note }}</p>
        </div>

        <div v-if="report.status === 'pending' || report.status === 'investigating'" class="report-actions-panel">
          <div class="report-punitive-actions">
            <button
              v-if="report.reported_post_id"
              class="report-action-btn warning"
              @click.stop="markPostSensitive(report)"
            >{{ report.reported_post_is_sensitive ? 'Unmark Sensitive' : 'Mark Sensitive' }}</button>
            <button
              v-if="report.reported_post_id"
              class="report-action-btn warning"
              @click.stop="setPostContentWarning(report)"
            >{{ report.reported_post_content_warning ? 'Edit CW' : 'Add CW' }}</button>
            <button
              v-if="report.reported_post_id"
              class="report-action-btn danger"
              @click.stop="deleteReportedPost(report)"
            >Delete Post</button>
            <button
              v-if="report.reported_message_id"
              class="report-action-btn danger"
              @click.stop="deleteReportedMessage(report)"
            >Delete Message</button>
            <button
              v-if="extractStorageUrls(report).length > 0"
              class="report-action-btn danger"
              @click.stop="deleteReportedMedia(report)"
            >Delete Media ({{ extractStorageUrls(report).length }})</button>
          </div>
          <div class="report-punitive-actions">
            <button
              v-if="report.reported_user_id"
              class="report-action-btn warning"
              @click.stop="forceSensitiveReportedUser(report)"
            >Force Sensitive Account</button>
            <button
              v-if="report.reported_user_id"
              class="report-action-btn warning"
              @click.stop="silenceReportedUser(report)"
            >Silence Account</button>
            <button
              v-if="report.reported_user_id"
              class="report-action-btn danger"
              @click.stop="suspendReportedUser(report)"
            >Suspend User</button>
          </div>

          <textarea
            v-model="reportResolutionNote"
            placeholder="Add resolution notes..."
            class="cyber-input resolution-textarea"
            rows="2"
            @click.stop
          ></textarea>
          <label class="toggle-label report-show-resolver" title="If checked, the reporter will see who resolved this (default off for harassment/backlash prevention)">
            <input type="checkbox" v-model="reportShowResolver" @click.stop />
            <span class="toggle-slider"></span>
            <span>Show my name to reporter</span>
          </label>
          <div class="report-action-buttons">
            <button
              v-if="report.status === 'pending'"
              class="report-action-btn investigating"
              @click.stop="updateReport(report.id, 'investigating')"
            >Mark Investigating</button>
            <button
              class="report-action-btn resolve"
              @click.stop="updateReport(report.id, 'resolved')"
            >Resolve</button>
            <button
              class="report-action-btn dismiss"
              @click.stop="updateReport(report.id, 'dismissed')"
            >Dismiss</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="reports-empty">
    <Icon name="check-circle" :size="32" />
    <p>No reports{{ activeReportFilter !== 'all' ? ` with status "${activeReportFilter}"` : '' }}</p>
  </div>
</div>

<!-- Recent Activity -->
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { escapeHtml } from '@/utils/sanitize'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import { adminService } from '@/services/AdminService'
import { reportService, type ReportWithDetails } from '@/services/ReportService'
import { messageService } from '@/services/MessageService'
import { userDataService } from '@/services/userDataService'
import { useAuthStore } from '@/stores/auth'
import { supabase } from '@/supabase'
import { formatDate } from './adminFormat'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

const authStore = useAuthStore()
const { confirm } = useConfirmDialog()
const router = useRouter()
const toast = useToast()

const reports = ref<ReportWithDetails[]>([])
const pendingReportsCount = ref(0)
const activeReportFilter = ref<string>('all')
const expandedReportId = ref<string | null>(null)
const reportResolutionNote = ref('')
const reportShowResolver = ref(false)
const reportFilters = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'dismissed', label: 'Dismissed' },
]

const loadReports = async () => {
  try {
    const statusParam = activeReportFilter.value === 'all' ? null : activeReportFilter.value
    const result = await reportService.getReports({ status: statusParam })
    reports.value = result.reports
    const ids = result.reports
      .flatMap((r) => [r.reporter_id, r.reported_user_id].filter(Boolean) as string[])
    if (ids.length > 0) {
      userDataService.ensureUsersLoaded(ids).catch(() => {})
    }
  } catch (error) {
    debug.error('Failed to load reports:', error)
  }
}

const loadPendingReportsCount = async () => {
  pendingReportsCount.value = await reportService.getPendingReportsCount()
}

const toggleReportExpand = (id: string) => {
  expandedReportId.value = expandedReportId.value === id ? null : id
  reportResolutionNote.value = ''
  reportShowResolver.value = false
}

const updateReport = async (reportId: string, status: 'investigating' | 'resolved' | 'dismissed') => {
  const options = (status === 'resolved' || status === 'dismissed') ? { showResolver: reportShowResolver.value } : undefined
  const success = await reportService.updateReportStatus(reportId, status, reportResolutionNote.value || undefined, options)
  if (success) {
    toast.success(`Report ${status}`)
    reportResolutionNote.value = ''
    expandedReportId.value = null
    await loadReports()
    await loadPendingReportsCount()
  } else {
    toast.error('Failed to update report')
  }
}

const linkifyReportPreview = (text: string): string => {
  const escaped = escapeHtml(text)
  return escaped.replace(
    /(https?:\/\/[^\s\]]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="report-link" onclick="event.stopPropagation()">$1</a>'
  )
}

const extractStorageUrls = (report: ReportWithDetails): string[] => {
  const preview = report.reported_message_preview || report.reported_post_preview || ''
  const supabaseHost = import.meta.env.VITE_SUPABASE_URL || ''
  const urls: string[] = []
  const urlRegex = /https?:\/\/[^\s\]]+/g
  let match
  while ((match = urlRegex.exec(preview)) !== null) {
    const url = match[0]
    if (url.includes('/storage/') || (supabaseHost && url.startsWith(supabaseHost))) {
      urls.push(url)
    }
  }
  return urls
}

const deleteReportedMedia = async (report: ReportWithDetails) => {
  const urls = extractStorageUrls(report)
  if (urls.length === 0) return
  if (!(await confirm({ title: 'Delete media', message: `Delete ${urls.length} media file(s) from storage? This cannot be undone.`, confirmButtonText: 'Delete', dangerAction: true }))) return

  let deleted = 0
  for (const url of urls) {
    try {
      const pathMatch = url.match(/\/storage\/v1\/object\/public\/([^?]+)/)
      if (pathMatch) {
        const fullPath = pathMatch[1]
        const slashIdx = fullPath.indexOf('/')
        const bucket = fullPath.substring(0, slashIdx)
        const filePath = fullPath.substring(slashIdx + 1)
        const { error } = await supabase.storage.from(bucket).remove([filePath])
        if (!error) deleted++
        else debug.error(`Failed to delete ${filePath}:`, error)
      }
    } catch (error) {
      debug.error('Failed to delete media:', error)
    }
  }

  if (deleted > 0) {
    await adminService.logAdminAction({ action: 'media_delete', targetType: 'storage', details: { count: deleted, urls } })
    toast.success(`Deleted ${deleted} media file(s)`)
  } else {
    toast.error('Failed to delete media files')
  }
}

const deleteReportedMessage = async (report: ReportWithDetails) => {
  if (!report.reported_message_id) return
  if (!(await confirm({ title: 'Delete message', message: 'Delete this message? This cannot be undone.', confirmButtonText: 'Delete', dangerAction: true }))) return
  try {
    await messageService.deleteMessage(report.reported_message_id)
    toast.success('Message deleted')
    await updateReport(report.id, 'resolved')
  } catch (error) {
    debug.error('Failed to delete message:', error)
    toast.error('Failed to delete message')
  }
}

const suspendReportedUser = async (report: ReportWithDetails) => {
  if (!report.reported_user_id) return
  const reason = prompt('Suspension reason:')
  if (!reason) return
  try {
    await adminService.moderateUser(report.reported_user_id, 'suspend', reason, authStore.session?.user?.id || '')
    toast.success(`User ${report.reported_user_display_name || report.reported_user_username} suspended`)
    await updateReport(report.id, 'resolved')
    window.dispatchEvent(new CustomEvent('admin:users-changed'))
  } catch (error) {
    debug.error('Failed to suspend user:', error)
    toast.error('Failed to suspend user')
  }
}

const markPostSensitive = async (report: ReportWithDetails) => {
  if (!report.reported_post_id) return
  try {
    const action = report.reported_post_is_sensitive ? 'unmark_sensitive' : 'mark_sensitive'
    await adminService.moderatePost(report.reported_post_id, action)
    report.reported_post_is_sensitive = !report.reported_post_is_sensitive
    toast.success(report.reported_post_is_sensitive ? 'Post marked as sensitive' : 'Post unmarked as sensitive')
  } catch (error) {
    debug.error('Failed to toggle sensitive:', error)
    toast.error('Failed to update post sensitivity')
  }
}

const setPostContentWarning = async (report: ReportWithDetails) => {
  if (!report.reported_post_id) return
  const cw = prompt('Content warning text (leave empty to remove):', report.reported_post_content_warning || '')
  if (cw === null) return
  try {
    if (cw.trim()) {
      await adminService.moderatePost(report.reported_post_id, 'set_cw', cw.trim())
      report.reported_post_content_warning = cw.trim()
      toast.success('Content warning set')
    } else {
      await adminService.moderatePost(report.reported_post_id, 'remove_cw')
      report.reported_post_content_warning = null
      toast.success('Content warning removed')
    }
  } catch (error) {
    debug.error('Failed to set content warning:', error)
    toast.error('Failed to update content warning')
  }
}

const deleteReportedPost = async (report: ReportWithDetails) => {
  if (!report.reported_post_id) return
  if (!(await confirm({ title: 'Delete post', message: 'Delete this post? This cannot be undone.', confirmButtonText: 'Delete', dangerAction: true }))) return
  try {
    await adminService.moderatePost(report.reported_post_id, 'delete')
    toast.success('Post deleted')
    await updateReport(report.id, 'resolved')
  } catch (error) {
    debug.error('Failed to delete post:', error)
    toast.error('Failed to delete post')
  }
}

const forceSensitiveReportedUser = async (report: ReportWithDetails) => {
  if (!report.reported_user_id) return
  const reason = prompt('Reason for marking all media as sensitive:')
  if (!reason) return
  try {
    await adminService.moderateUser(report.reported_user_id, 'force_sensitive', reason, authStore.session?.user?.id || '')
    toast.success(`All future media from ${report.reported_user_display_name || report.reported_user_username} will be marked sensitive`)
  } catch (error) {
    debug.error('Failed to force sensitive:', error)
    toast.error('Failed to force-sensitive account')
  }
}

const silenceReportedUser = async (report: ReportWithDetails) => {
  if (!report.reported_user_id) return
  const reason = prompt('Reason for silencing (hiding from public timelines):')
  if (!reason) return
  try {
    await adminService.moderateUser(report.reported_user_id, 'silence', reason, authStore.session?.user?.id || '')
    toast.success(`User ${report.reported_user_display_name || report.reported_user_username} silenced`)
  } catch (error) {
    debug.error('Failed to silence user:', error)
    toast.error('Failed to silence user')
  }
}

const navigateToReportUser = (report: ReportWithDetails, which: 'reporter' | 'reported') => {
  let username: string | null
  let domain: string | null
  if (which === 'reporter') {
    username = report.reporter_username
    domain = report.reporter_domain
  } else {
    username = report.reported_user_username
    domain = report.reported_user_domain
  }
  if (!username) return
  const localDomain = import.meta.env.VITE_DOMAIN as string
  const handle = (domain && domain !== localDomain) ? `${username}@${domain}` : username
  router.push({ name: 'UserProfile', params: { handle } })
}

const navigateToPost = (postId: string) => {
  router.push(`/post/${postId}`)
}


onMounted(() => {
  void loadReports()
  void loadPendingReportsCount()
})
</script>

<style scoped>




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
  color: var(--text-primary);
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





/* Reports & Moderation */
.reports-badge {
  background: #ed4245;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 10px;
  margin-left: auto;
}





.report-filters {
  display: flex;
  gap: 4px;
  padding: 16px 20px;
  flex-wrap: wrap;
}





.reports-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 20px 20px;
}





.report-item {
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s;
}





.report-item:hover {
  border-color: var(--accent-color);
}





.report-item.expanded {
  border-color: var(--accent-color);
}





.report-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  flex-wrap: wrap;
}





.report-type-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}





.report-type-badge.user { background: rgba(14, 165, 233, 0.2); color: #38BDF8; }




.report-type-badge.post { background: rgba(87, 242, 135, 0.2); color: #57f287; }




.report-type-badge.message { background: rgba(254, 231, 92, 0.2); color: #fee75c; }




.report-type-badge.server { background: rgba(235, 69, 158, 0.2); color: #eb459e; }





.report-users {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}





.report-reporter,
.report-reported {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary);
}





.report-arrow {
  color: var(--text-secondary);
  font-size: 12px;
}





.report-reason {
  font-size: 13px;
  color: var(--text-secondary);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 80px;
}





.report-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}





.report-source {
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 6px;
  border-radius: 4px;
}





.report-status-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}





.report-status-badge.pending { background: rgba(254, 231, 92, 0.2); color: #fee75c; }




.report-status-badge.investigating { background: rgba(14, 165, 233, 0.2); color: #38BDF8; }




.report-status-badge.resolved { background: rgba(87, 242, 135, 0.2); color: #57f287; }




.report-status-badge.dismissed { background: rgba(255, 255, 255, 0.1); color: var(--text-secondary); }





.report-detail {
  border-top: 1px solid var(--border-color);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}





.report-detail label {
  display: flex;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin-bottom: 4px;
  letter-spacing: 0.5px;
}





.report-detail p {
  margin: 0;
  font-size: 14px;
  color: var(--text-primary);
}





.report-proof blockquote {
  margin: 0;
  padding: 8px 12px;
  border-left: 3px solid var(--accent-color);
  background: rgba(0, 0, 0, 0.2);
  border-radius: 0 6px 6px 0;
  font-size: 14px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}





.report-proof :deep(.report-link) {
  color: var(--accent-color);
  text-decoration: underline;
  word-break: break-all;
}





.report-proof :deep(.report-link:hover) {
  opacity: 0.8;
}





.report-actions-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}





.resolution-textarea {
  width: 100%;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
}





.report-punitive-actions {
  display: flex;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 4px;
}





.report-action-btn.danger {
  background: rgba(237, 66, 69, 0.2);
  color: #ed4245;
}





.report-action-btn.danger:hover {
  background: rgba(237, 66, 69, 0.4);
}





.report-action-buttons {
  display: flex;
  gap: 8px;
}





.report-action-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}





.report-action-btn:hover {
  opacity: 0.85;
}





.report-action-btn.investigating {
  background: rgba(14, 165, 233, 0.3);
  color: #38BDF8;
}





.report-action-btn.resolve {
  background: rgba(87, 242, 135, 0.3);
  color: #57f287;
}





.report-action-btn.dismiss {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-secondary);
}





.report-action-btn.warning {
  background: rgba(250, 166, 26, 0.2);
  color: #faa61a;
}





.report-action-btn.warning:hover {
  background: rgba(250, 166, 26, 0.4);
}





.federation-badge {
  background: rgba(88, 101, 242, 0.2);
  color: #7c8af5;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  margin-left: 4px;
}





.report-user-link {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}





.report-user-link:hover {
  text-decoration: underline;
  color: var(--accent-color);
}





.report-external-link {
  display: inline-flex;
  align-items: center;
  color: var(--text-secondary);
  margin-left: 4px;
  opacity: 0.7;
  transition: opacity 0.15s;
}





.report-external-link:hover {
  opacity: 1;
  color: var(--accent-color);
}





.report-source-local {
  font-size: 11px;
  color: var(--text-tertiary);
}





.report-post-meta {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}





.report-post-links {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}





.report-link-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s;
}





.report-link-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-primary);
}





.reports-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 20px;
  color: var(--text-secondary);
  font-size: 14px;
}
</style>

<style scoped src="./adminShared.css"></style>
