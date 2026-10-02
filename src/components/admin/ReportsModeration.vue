<template>
<!-- Reports & Moderation -->
<div class="admin-module reports-module">
  <div class="module-header">
    <Icon name="flag" :size="20" />
    <h2>{{ serverId ? 'Reports in this server' : 'Reports & moderation' }}</h2>
    <span v-if="pendingCount > 0" class="reports-badge">{{ pendingCount }} pending</span>
  </div>

  <div class="report-filters">
    <button
      v-for="filter in reportFilters"
      :key="filter.key"
      @click="setFilter(filter.key)"
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
        <div class="report-category-badge">{{ categoryLabel(report.category) }}</div>
        <div class="report-users">
          <div class="report-reporter">
            <template v-if="report.source === 'federation'">
              <Icon name="globe" :size="14" />
              <span class="federation-badge" :title="report.source_actor || undefined">{{ reportSourceLabel(report) }}</span>
            </template>
            <template v-else-if="report.reporter_id || report.reporter_username">
              <Avatar :src="report.reporter_avatar_url" :alt="report.reporter_username ?? undefined" size="xs" />
              <span class="report-user-link" @click.stop="navigateToReportUser(report, 'reporter')">
                <DisplayName v-if="report.reporter_id" :user-id="report.reporter_id" :fallback="(report.reporter_display_name || report.reporter_username) ?? undefined" />
                <template v-else>{{ report.reporter_display_name || report.reporter_username }}</template>
              </span>
            </template>
            <span v-else class="report-anonymous">Anonymous reporter</span>
          </div>
          <span class="report-arrow">&#8594;</span>
          <div class="report-reported" v-if="report.reported_user_id || report.reported_user_username">
            <Avatar :src="report.reported_user_avatar_url" :alt="report.reported_user_username ?? undefined" size="xs" />
            <span class="report-user-link" @click.stop="navigateToReportUser(report, 'reported')">
              <DisplayName v-if="report.reported_user_id" :user-id="report.reported_user_id" :fallback="(report.reported_user_display_name || report.reported_user_username) ?? undefined" />
              <template v-else>{{ report.reported_user_display_name || report.reported_user_username }}</template>
              <span v-if="!report.reported_user_is_local && report.reported_user_domain" class="federation-badge" title="Federated user">
                @{{ report.reported_user_domain }}
              </span>
            </span>
            <span v-if="report.reported_user_is_suspended" class="badge-mini danger">suspended</span>
            <span v-else-if="report.reported_user_is_silenced" class="badge-mini warning">silenced</span>
            <span v-if="report.open_reports_on_target > 1" class="badge-mini" :title="`${report.open_reports_on_target} open reports on this account`">
              {{ report.open_reports_on_target }} open
            </span>
          </div>
        </div>
        <div class="report-reason">{{ reasonLabel(report.reason) }}</div>
        <div class="report-meta">
          <span v-if="report.source === 'local'" class="report-source-local">local</span>
          <span v-if="report.forwarded_at" class="report-source federation-badge" title="An anonymous copy was sent to the account's instance">forwarded</span>
          <span v-if="report.assigned_username" class="report-source">@{{ report.assigned_username }}</span>
          <time class="report-time">{{ formatDate(report.created_at) }}</time>
        </div>
        <div class="report-status-badge" :class="report.status">{{ report.status }}</div>
      </div>

      <div v-if="expandedReportId === report.id" class="report-detail" @click.stop>
        <div v-if="report.comment" class="report-comment">
          <label>{{ report.source === 'federation' ? `Comment from ${report.source_instance}` : "Reporter's comment" }}</label>
          <p>{{ report.comment }}</p>
        </div>

        <div v-for="(item, i) in snapshotEvidence(report.content_snapshot)" :key="i" class="report-proof">
          <label>{{ item.label }}<span v-if="item.note" class="evidence-note"> &middot; {{ item.note }}</span></label>
          <blockquote v-html="linkifyReportPreview(item.text)"></blockquote>
        </div>

        <div v-if="report.reported_message_id || report.report_type === 'message'" class="report-proof">
          <label>Message now</label>
          <p v-if="report.reported_message_is_deleted" class="evidence-gone">Deleted since the report</p>
          <blockquote v-else-if="report.reported_message_preview" v-html="linkifyReportPreview(report.reported_message_preview)"></blockquote>
        </div>

        <div v-if="report.reported_post_id || report.report_type === 'post'" class="report-proof">
          <label>Post now</label>
          <p v-if="report.reported_post_is_deleted" class="evidence-gone">Deleted since the report</p>
          <template v-else>
            <blockquote v-if="report.reported_post_preview" v-html="linkifyReportPreview(report.reported_post_preview)"></blockquote>
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
          </template>
        </div>

        <div v-if="report.resolution_note" class="report-resolution">
          <label>Note sent to the reporter</label>
          <p>{{ report.resolution_note }}</p>
        </div>
        <p v-if="report.resolver_username && !isOpenReport(report.status)" class="report-resolver">
          {{ report.status }} by @{{ report.resolver_username }}
        </p>

        <div class="report-actions-panel">
          <div v-if="contentActions(report).length" class="report-punitive-actions">
            <button
              v-for="action in contentActions(report)"
              :key="action"
              class="report-action-btn"
              :class="DESTRUCTIVE_ACTIONS.has(action) ? 'danger' : 'warning'"
              :disabled="busy"
              @click.stop="runAction(report, action)"
            >{{ actionLabel(report, action) }}</button>
            <button
              v-if="!serverId && extractStorageUrls(report).length > 0 && isAdmin"
              class="report-action-btn danger"
              :disabled="busy"
              @click.stop="deleteReportedMedia(report)"
            >Delete media ({{ extractStorageUrls(report).length }})</button>
          </div>

          <template v-if="isOpenReport(report.status)">
            <textarea
              v-model="reportNote"
              placeholder="Note to the reporter (optional, sent on resolve or dismiss)"
              class="cyber-input resolution-textarea"
              rows="2"
              maxlength="1000"
              @click.stop
            ></textarea>
            <label class="toggle-label report-show-resolver" title="Off by default, to protect moderators from retaliation">
              <input type="checkbox" v-model="reportShowResolver" @click.stop />
              <span class="toggle-slider"></span>
              <span>Show my name to the reporter</span>
            </label>
          </template>

          <div class="report-action-buttons">
            <button
              v-for="action in statusActions(report)"
              :key="action"
              class="report-action-btn"
              :class="statusActionClass(action)"
              :disabled="busy"
              @click.stop="runAction(report, action)"
            >{{ actionLabel(report, action) }}</button>
          </div>
        </div>
      </div>
    </div>

    <button v-if="reports.length < total" class="filter-btn load-more" :disabled="busy" @click="loadMore">
      Load more ({{ total - reports.length }})
    </button>
  </div>

  <EmptyState
    v-else
    icon="check-circle"
    :title="activeReportFilter !== 'all' ? $t('empty.admin.reports.filtered', { status: activeReportFilter }) : $t('empty.admin.reports.title')"
  />
</div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { escapeHtml } from '@/utils/sanitize'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import { adminService } from '@/services/AdminService'
import { reportService, type ReportWithDetails } from '@/services/ReportService'
import { userDataService } from '@/services/userDataService'
import { supabase } from '@/supabase'
import { formatDate } from './adminFormat'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import {
  ACTIONS_WITH_REASON,
  DESTRUCTIVE_ACTIONS,
  REPORT_CATEGORY_LABELS,
  REPORT_REASONS,
  isOpenReport,
  reportActionsFor,
  reportSourceLabel,
  snapshotEvidence,
  type ReportAction,
  type ReportCategory,
} from '@/utils/reportModeration'

const props = defineProps<{
  /** Lists only this server's reports, as a server moderator. */
  serverId?: string
}>()

const { confirm } = useConfirmDialog()
const router = useRouter()
const toast = useToast()

const PAGE = 50

const reports = ref<ReportWithDetails[]>([])
const total = ref(0)
const pendingCount = ref(0)
const activeReportFilter = ref<string>('pending')
const expandedReportId = ref<string | null>(null)
const reportNote = ref('')
const reportShowResolver = ref(false)
const busy = ref(false)
const isAdmin = ref(false)
const isInstanceModerator = ref(false)
const currentProfileId = ref<string | null>(null)

const reportFilters = [
  { key: 'pending', label: 'Pending' },
  { key: 'investigating', label: 'Investigating' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'all', label: 'All' },
]

const STATUS_ACTIONS: ReadonlySet<ReportAction> = new Set<ReportAction>([
  'investigate', 'resolve', 'dismiss', 'reopen', 'assign', 'unassign', 'forward',
])

const categoryLabel = (category: string) =>
  REPORT_CATEGORY_LABELS[category as ReportCategory] ?? category

const reasonLabel = (reason: string) =>
  REPORT_REASONS.find((r) => r.value === reason)?.label ?? reason

const role = () => ({
  isAdmin: !props.serverId && isAdmin.value,
  isInstanceModerator: !props.serverId && isInstanceModerator.value,
})

const allActions = (report: ReportWithDetails) =>
  reportActionsFor(report, role(), currentProfileId.value)

const statusActions = (report: ReportWithDetails) =>
  allActions(report).filter((a) => STATUS_ACTIONS.has(a))

const contentActions = (report: ReportWithDetails) =>
  allActions(report).filter((a) => !STATUS_ACTIONS.has(a))

const statusActionClass = (action: ReportAction) => {
  switch (action) {
    case 'investigate': return 'investigating'
    case 'resolve': return 'resolve'
    case 'forward': return 'warning'
    default: return 'dismiss'
  }
}

const actionLabel = (report: ReportWithDetails, action: ReportAction): string => {
  switch (action) {
    case 'investigate': return 'Mark investigating'
    case 'resolve': return 'Resolve'
    case 'dismiss': return 'Dismiss'
    case 'reopen': return 'Reopen'
    case 'assign': return 'Assign to me'
    case 'unassign': return 'Unassign'
    case 'forward': return `Forward to ${report.reported_user_domain}`
    case 'delete_post': return 'Delete post'
    case 'mark_sensitive': return 'Mark sensitive'
    case 'delete_message': return 'Delete message'
    case 'warn': return 'Warn account'
    case 'silence_account': return 'Silence account'
    case 'suspend_account': return 'Suspend account'
    case 'force_sensitive_account': return 'Force sensitive media'
    case 'limit_domain': return `Limit ${report.reported_user_domain}`
    case 'suspend_domain': return `Suspend ${report.reported_user_domain}`
  }
}

const reasonPrompt = (report: ReportWithDetails, action: ReportAction): string => {
  switch (action) {
    case 'warn': return 'Warning text sent to the account:'
    case 'limit_domain': return `Reason for limiting ${report.reported_user_domain}:`
    case 'suspend_domain': return `Reason for suspending ${report.reported_user_domain}:`
    default: return 'Reason (kept with the account):'
  }
}

const loadRole = async () => {
  try {
    const { authContextService } = await import('@/services/AuthContextService')
    currentProfileId.value = await authContextService.getCurrentProfileId()
    const { data } = await supabase
      .from('profiles')
      .select('is_admin, is_moderator')
      .eq('id', currentProfileId.value)
      .maybeSingle()
    isAdmin.value = data?.is_admin === true
    isInstanceModerator.value = data?.is_admin === true || data?.is_moderator === true
  } catch (error) {
    debug.error('Failed to resolve moderator role:', error)
  }
}

const loadReports = async (append = false) => {
  const statusParam = activeReportFilter.value === 'all' ? null : activeReportFilter.value
  const result = await reportService.getReports({
    status: statusParam,
    limit: PAGE,
    offset: append ? reports.value.length : 0,
    serverId: props.serverId ?? null,
  })
  reports.value = append ? [...reports.value, ...result.reports] : result.reports
  total.value = result.total
  const ids = result.reports
    .flatMap((r) => [r.reporter_id, r.reported_user_id].filter(Boolean) as string[])
  if (ids.length > 0) {
    userDataService.ensureUsersLoaded(ids).catch(() => {})
  }
}

const loadPendingCount = async () => {
  if (props.serverId) {
    const result = await reportService.getReports({ status: 'pending', limit: 1, serverId: props.serverId })
    pendingCount.value = result.total
  } else {
    pendingCount.value = await reportService.getPendingReportsCount()
  }
}

const refresh = async () => {
  await Promise.all([loadReports(), loadPendingCount()])
}

const loadMore = () => loadReports(true)

const setFilter = (key: string) => {
  activeReportFilter.value = key
  expandedReportId.value = null
}

watch(activeReportFilter, () => { void loadReports() })

const toggleReportExpand = (id: string) => {
  expandedReportId.value = expandedReportId.value === id ? null : id
  reportNote.value = ''
  reportShowResolver.value = false
}

const runAction = async (report: ReportWithDetails, action: ReportAction) => {
  let reason: string | undefined
  if (ACTIONS_WITH_REASON.has(action)) {
    const answer = prompt(reasonPrompt(report, action))
    if (answer === null) return
    reason = answer
  }
  if (DESTRUCTIVE_ACTIONS.has(action)) {
    const ok = await confirm({
      title: actionLabel(report, action),
      message: `${actionLabel(report, action)}? This resolves the report.`,
      confirmButtonText: actionLabel(report, action),
      dangerAction: true,
    })
    if (!ok) return
  }

  busy.value = true
  try {
    const result = await reportService.moderateReport(report.id, action, {
      note: reportNote.value || undefined,
      reason,
      showResolver: reportShowResolver.value,
    })
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    toast.success(`${actionLabel(report, action)}: done`)
    if (!STATUS_ACTIONS.has(action) || action === 'resolve' || action === 'dismiss') {
      reportNote.value = ''
      expandedReportId.value = null
    }
    if (action === 'suspend_account' || action === 'silence_account') {
      window.dispatchEvent(new CustomEvent('admin:users-changed'))
    }
    await refresh()
  } finally {
    busy.value = false
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
    await adminService.logAdminAction({ action: 'media_delete', targetType: 'storage', details: { count: deleted, urls, report_id: report.id } })
    toast.success(`Deleted ${deleted} media file(s)`)
  } else {
    toast.error('Failed to delete media files')
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

onMounted(async () => {
  await loadRole()
  await refresh()
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





.filter-btn {
  padding: 8px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}





.filter-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.filter-btn.active {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
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
  background: var(--error);
  color: var(--text-on-primary);
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: var(--radius-full);
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
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color 0.15s;
}





.report-item:hover {
  border-color: var(--harmony-primary);
}





.report-item.expanded {
  border-color: var(--harmony-primary);
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
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}





.report-type-badge.user { background: var(--background-modifier-active); color: var(--text-secondary); }




.report-type-badge.post { background: var(--background-modifier-active); color: var(--text-secondary); }




.report-type-badge.message { background: var(--background-modifier-active); color: var(--text-secondary); }




.report-type-badge.server { background: var(--background-modifier-active); color: var(--text-secondary); }





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
  background: var(--background-modifier-active);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}





.report-status-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}





.report-status-badge.pending { background: color-mix(in srgb, var(--warning) 20%, transparent); color: var(--warning); }




.report-status-badge.investigating { background: color-mix(in srgb, var(--info) 20%, transparent); color: var(--info); }




.report-status-badge.resolved { background: color-mix(in srgb, var(--success) 20%, transparent); color: var(--success); }




.report-status-badge.dismissed { background: var(--background-modifier-active); color: var(--text-secondary); }





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
  border-left: 3px solid var(--harmony-primary);
  background: var(--background-secondary);
  border-radius: 0 var(--radius-base) var(--radius-base) 0;
  font-size: 14px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}





.report-proof :deep(.report-link) {
  color: var(--harmony-primary);
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
  border-radius: var(--radius-base);
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
  background: color-mix(in srgb, var(--error) 20%, transparent);
  color: var(--error);
}





.report-action-btn.danger:hover {
  background: color-mix(in srgb, var(--error) 40%, transparent);
}





.report-action-buttons {
  display: flex;
  gap: 8px;
}





.report-action-btn {
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius-base);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}





.report-action-btn:hover {
  opacity: 0.85;
}





.report-action-btn.investigating {
  background: color-mix(in srgb, var(--info) 30%, transparent);
  color: var(--info);
}





.report-action-btn.resolve {
  background: color-mix(in srgb, var(--success) 30%, transparent);
  color: var(--success);
}





.report-action-btn.dismiss {
  background: var(--background-modifier-active);
  color: var(--text-secondary);
}





.report-action-btn.warning {
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--warning);
}





.report-action-btn.warning:hover {
  background: color-mix(in srgb, var(--warning) 40%, transparent);
}





.federation-badge {
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  color: var(--harmony-primary);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
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
  color: var(--harmony-primary);
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
  color: var(--harmony-primary);
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
  background: var(--background-modifier-hover);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s;
}





.report-link-btn:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}
.report-category-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--harmony-primary) 12%, transparent);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.report-anonymous {
  font-size: 13px;
  color: var(--text-secondary);
  font-style: italic;
}

.badge-mini {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--background-modifier-active);
  color: var(--text-secondary);
}

.badge-mini.danger { color: var(--error); }
.badge-mini.warning { color: var(--warning); }

.evidence-note {
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

.evidence-gone {
  font-style: italic;
  color: var(--text-secondary);
}

.report-resolver {
  font-size: 12px;
  color: var(--text-secondary);
}

.report-punitive-actions {
  flex-wrap: wrap;
}

.report-action-buttons {
  flex-wrap: wrap;
}

.report-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.load-more {
  align-self: center;
  margin-top: 8px;
}
</style>

<style scoped src="./adminShared.css"></style>
