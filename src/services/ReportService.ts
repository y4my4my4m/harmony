import { i18n } from '@/i18n'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import {
  REPORT_REASONS,
  reportErrorMessage,
  type ReportAction,
  type ReportCategory,
  type ReportReason,
  type ReportSnapshot,
} from '@/utils/reportModeration'

export { REPORT_REASONS }
export type { ReportAction, ReportCategory, ReportReason }

export type ReportStatus = 'pending' | 'investigating' | 'resolved' | 'dismissed'
export type ReportType = 'user' | 'post' | 'message' | 'server'

/** A reporter's own report: the columns the reports column grant exposes (getMyReports). */
export interface Report {
  id: string
  created_at: string
  updated_at: string | null
  reporter_id: string | null
  reported_user_id: string | null
  reported_post_id: string | null
  reported_message_id: string | null
  reported_server_id: string | null
  reason: string
  category: ReportCategory
  comment: string | null
  report_type: ReportType
  status: ReportStatus
  resolved_at: string | null
  forward: boolean
  forwarded_at: string | null
}

/** One row of get_reports_with_details. Reporter fields are null for server moderators. */
export interface ReportWithDetails {
  id: string
  created_at: string
  updated_at: string | null
  status: ReportStatus
  report_type: ReportType
  category: ReportCategory
  reason: string
  comment: string | null
  source: 'local' | 'federation'
  source_instance: string | null
  source_actor: string | null
  reporter_id: string | null
  reporter_username: string | null
  reporter_display_name: string | null
  reporter_avatar_url: string | null
  reporter_domain: string | null
  reporter_is_local: boolean | null
  reported_user_id: string | null
  reported_user_username: string | null
  reported_user_display_name: string | null
  reported_user_avatar_url: string | null
  reported_user_domain: string | null
  reported_user_is_local: boolean
  reported_user_is_suspended: boolean
  reported_user_is_silenced: boolean
  reported_domain_blocked: boolean
  reported_domain_limited: boolean
  reported_post_id: string | null
  reported_message_id: string | null
  reported_server_id: string | null
  scope_server_id: string | null
  reported_post_preview: string | null
  reported_post_ap_id: string | null
  reported_post_url: string | null
  reported_post_is_sensitive: boolean | null
  reported_post_content_warning: string | null
  reported_post_is_deleted: boolean | null
  reported_message_preview: string | null
  reported_message_is_deleted: boolean | null
  content_snapshot: ReportSnapshot | null
  forward: boolean
  forwarded_at: string | null
  federation_status: string | null
  assigned_to: string | null
  assigned_username: string | null
  resolved_at: string | null
  resolver_username: string | null
  resolution_note: string | null
  open_reports_on_target: number
  total_count: number
}

export interface CreateReportParams {
  report_type: ReportType
  reported_user_id?: string
  reported_post_id?: string
  reported_message_id?: string
  reported_server_id?: string
  reason: ReportReason | string
  category?: ReportCategory
  comment?: string
  /** Forward to the reported account's instance; ignored for a local account. */
  forward?: boolean
  /** Plaintext the reporter saw; kept only for an encrypted message. */
  evidence_text?: string
}

export type CreateReportResult = { ok: true; id: string } | { ok: false; message: string }

export interface ModerateReportOptions {
  /** Sent to the reporter on resolve or dismiss. */
  note?: string
  /** Kept with an account, warning or domain action; not sent to the reporter. */
  reason?: string
  /** Name the moderator in the reporter's notification. */
  showResolver?: boolean
}

class ReportService {
  async createReport(params: CreateReportParams): Promise<CreateReportResult> {
    const { data, error } = await supabase.rpc('create_report', {
      p_report_type: params.report_type,
      p_reported_user_id: params.reported_user_id ?? null,
      p_reported_post_id: params.reported_post_id ?? null,
      p_reported_message_id: params.reported_message_id ?? null,
      p_reported_server_id: params.reported_server_id ?? null,
      p_reason: params.reason,
      p_category: params.category ?? null,
      p_comment: params.comment?.trim() || null,
      p_forward: params.forward === true,
      p_evidence_text: params.evidence_text ?? null,
    })
    if (error || typeof data !== 'string') {
      debug.error('Failed to create report:', error)
      return { ok: false, message: reportErrorMessage(error) }
    }
    debug.log('Report created:', data)
    return { ok: true, id: data }
  }

  async getMyReports(): Promise<Report[]> {
    try {
      const { authContextService } = await import('@/services/AuthContextService')
      const reporterProfileId = await authContextService.getCurrentProfileId()

      const { data, error } = await supabase
        .from('reports')
        .select('id, created_at, updated_at, reporter_id, reported_user_id, reported_post_id, reported_message_id, reported_server_id, reason, category, comment, report_type, status, resolved_at, forward, forwarded_at')
        .eq('reporter_id', reporterProfileId)
        .order('created_at', { ascending: false })

      if (error) throw error
      return (data ?? []) as unknown as Report[]
    } catch (error) {
      debug.error('Failed to get my reports:', error)
      return []
    }
  }

  async getPendingReportsCount(): Promise<number> {
    try {
      const { data, error } = await supabase.rpc('get_pending_reports_count')
      if (error) throw error
      return data || 0
    } catch (error) {
      debug.error('Failed to get pending reports count:', error)
      return 0
    }
  }

  /** Instance queue, or one server's reports with serverId. */
  async getReports(options: {
    status?: string | null
    limit?: number
    offset?: number
    serverId?: string | null
  } = {}): Promise<{ reports: ReportWithDetails[]; total: number }> {
    try {
      const { status = null, limit = 50, offset = 0, serverId = null } = options

      const { data, error } = await supabase.rpc('get_reports_with_details', {
        p_status: status,
        p_limit: limit,
        p_offset: offset,
        p_server_id: serverId,
      })

      if (error) throw error

      const reports = (data ?? []) as ReportWithDetails[]
      return { reports, total: Number(reports[0]?.total_count ?? 0) }
    } catch (error) {
      debug.error('Failed to get reports:', error)
      return { reports: [], total: 0 }
    }
  }

  /**
   * Applies a moderator action. The database checks the caller's role, logs the
   * action and notifies the reporter.
   */
  async moderateReport(
    reportId: string,
    action: ReportAction,
    options: ModerateReportOptions = {}
  ): Promise<{ ok: true; status: ReportStatus } | { ok: false; message: string }> {
    const { data, error } = await supabase.rpc('moderate_report', {
      p_report_id: reportId,
      p_action: action,
      p_note: options.note?.trim() || null,
      p_reason: options.reason?.trim() || null,
      p_show_resolver: options.showResolver === true,
    })
    if (error) {
      debug.error(`moderate_report ${action} failed:`, error)
      return { ok: false, message: error.message || i18n.global.t('moderation.reportErrors.actionFailed') }
    }
    return { ok: true, status: (data as { status: ReportStatus }).status }
  }

  async updateReportStatus(
    reportId: string,
    status: 'investigating' | 'resolved' | 'dismissed',
    resolutionNote?: string,
    options?: { showResolver?: boolean }
  ): Promise<boolean> {
    const action: ReportAction =
      status === 'investigating' ? 'investigate' : status === 'resolved' ? 'resolve' : 'dismiss'
    const result = await this.moderateReport(reportId, action, {
      note: resolutionNote,
      showResolver: options?.showResolver,
    })
    return result.ok
  }
}

export const reportService = new ReportService()
