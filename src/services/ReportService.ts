import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

export interface Report {
  id: string
  reporter_id: string
  reported_user_id?: string
  reported_post_id?: string
  reported_message_id?: string
  reported_server_id?: string
  reason: string
  comment?: string
  status: 'pending' | 'investigating' | 'resolved' | 'dismissed'
  report_type: 'user' | 'post' | 'message' | 'server'
  source: 'local' | 'federation'
  source_instance?: string
  created_at: string
  updated_at: string
  reporter?: {
    username: string
    display_name: string
    avatar_url: string
  }
  reported_user?: {
    username: string
    display_name: string
    avatar_url: string
  }
}

export interface ReportWithDetails {
  id: string
  reporter_id: string | null
  reported_user_id: string | null
  reported_message_id: string | null
  reported_post_id: string | null
  reporter_username: string
  reporter_display_name: string
  reporter_avatar_url: string
  reporter_domain: string | null
  reporter_is_local: boolean
  reported_user_username: string | null
  reported_user_display_name: string | null
  reported_user_avatar_url: string | null
  reported_user_domain: string | null
  reported_user_is_local: boolean
  reported_post_preview: string | null
  reported_post_ap_id: string | null
  reported_post_url: string | null
  reported_post_is_sensitive: boolean | null
  reported_post_content_warning: string | null
  reported_message_preview: string | null
  reason: string
  comment: string | null
  report_type: string
  source: string
  source_instance: string | null
  status: string
  resolution_note: string | null
  created_at: string
}

export interface CreateReportParams {
  reported_user_id?: string
  reported_post_id?: string
  reported_message_id?: string
  reported_server_id?: string
  report_type: 'user' | 'post' | 'message' | 'server'
  reason: string
  comment?: string
}

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'illegal_content'
  | 'impersonation'
  | 'nsfw'
  | 'other'

export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'spam', label: 'Spam or unwanted content' },
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'illegal_content', label: 'Illegal content' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'nsfw', label: 'Inappropriate/NSFW content' },
  { value: 'other', label: 'Other' }
]

class ReportService {
  async createReport(params: CreateReportParams): Promise<Report | null> {
    try {
      // BUGS.md Pattern A: `reports.reporter_id` references `profiles(id)`
      // (see db_schema/init/06_tables_misc.sql) and RLS enforces
      // `reporter_id = get_current_profile_id()`. Inserting `user.id`
      // (auth UUID) either failed the FK / RLS check outright or wrote
      // garbage data - never the right behavior. Resolve to profile id.
      const { authContextService } = await import('@/services/AuthContextService')
      const reporterProfileId = await authContextService.getCurrentProfileId()

      const { data, error } = await supabase
        .from('reports')
        .insert({
          reporter_id: reporterProfileId,
          reported_user_id: params.reported_user_id || null,
          reported_post_id: params.reported_post_id || null,
          reported_message_id: params.reported_message_id || null,
          reported_server_id: params.reported_server_id || null,
          report_type: params.report_type,
          reason: params.reason,
          comment: params.comment || null,
          status: 'pending',
          source: 'local'
        })
        .select()
        .single()

      if (error) throw error
      debug.log('Report created:', data.id)
      return data
    } catch (error) {
      debug.error('Failed to create report:', error)
      return null
    }
  }

  async getMyReports(): Promise<Report[]> {
    try {
      // Same pattern A fix as createReport - filter by profile id.
      let reporterProfileId: string
      try {
        const { authContextService } = await import('@/services/AuthContextService')
        reporterProfileId = await authContextService.getCurrentProfileId()
      } catch {
        return []
      }

      const { data, error } = await supabase
        .from('reports')
        .select('*')
        .eq('reporter_id', reporterProfileId)
        .order('created_at', { ascending: false })

      if (error) throw error
      return data || []
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

  async getReports(options: {
    status?: string | null
    limit?: number
    offset?: number
  } = {}): Promise<{ reports: ReportWithDetails[]; total: number }> {
    try {
      const { status = null, limit = 25, offset = 0 } = options

      const { data, error } = await supabase.rpc('get_reports_with_details', {
        p_status: status,
        p_limit: limit,
        p_offset: offset
      })

      if (error) throw error

      return {
        reports: data || [],
        total: data?.length || 0
      }
    } catch (error) {
      debug.error('Failed to get reports:', error)
      return { reports: [], total: 0 }
    }
  }

  async updateReportStatus(
    reportId: string,
    status: 'investigating' | 'resolved' | 'dismissed',
    resolutionNote?: string,
    options?: { showResolver?: boolean }
  ): Promise<boolean> {
    try {
      const updateData: Record<string, unknown> = {
        status,
        updated_at: new Date().toISOString(),
      }

      if (resolutionNote !== undefined) {
        updateData.resolution_note = resolutionNote
      }

      // BUGS.md Pattern A: `resolved_by` and the notification `from_user_id`
      // both reference `profiles(id)`. Resolve once at the top so the same
      // id flows into the update and the notification payload below.
      let resolverProfileId: string | null = null
      try {
        const { authContextService } = await import('@/services/AuthContextService')
        resolverProfileId = await authContextService.getCurrentProfileId()
      } catch {
        // No authenticated profile - bail if we need to attribute this action.
        if (status === 'resolved' || status === 'dismissed') {
          return false
        }
      }

      if (status === 'resolved' || status === 'dismissed') {
        updateData.resolved_at = new Date().toISOString()
        updateData.resolved_by = resolverProfileId
      }

      const { error } = await supabase
        .from('reports')
        .update(updateData)
        .eq('id', reportId)

      if (error) throw error

      // Notify the reporter about the status change (default: do not show who resolved, for harassment/backlash prevention)
      try {
        const { data: report } = await supabase
          .from('reports')
          .select('reporter_id, report_type')
          .eq('id', reportId)
          .single()

        if (report?.reporter_id) {
          const showResolver = options?.showResolver === true
          const notificationData: Record<string, unknown> = {
            report_id: reportId,
            status,
            report_type: report.report_type,
            resolution_note: resolutionNote ?? null,
            show_resolver: showResolver,
          }
          if (showResolver && resolverProfileId) {
            // Look up the resolver by PROFILE id (Pattern A - the old
            // `.eq('id', user.id)` was already broken: `user.id` was the
            // auth UUID but `profiles.id` is the profile UUID).
            const { data: resolverProfile } = await supabase
              .from('profiles')
              .select('username, display_name, avatar_url')
              .eq('id', resolverProfileId)
              .maybeSingle()
            if (resolverProfile) {
              notificationData.resolver_username = resolverProfile.username
              notificationData.resolver_display_name = resolverProfile.display_name
              notificationData.resolver_avatar_url = resolverProfile.avatar_url
            }
          }
          await supabase.rpc('send_notification_to_user', {
            notification_type: 'report_update',
            to_user_id: report.reporter_id,
            notification_data: notificationData,
            from_user_id: showResolver ? resolverProfileId : null,
          })
        }
      } catch (notifError) {
        debug.warn('Failed to send report status notification:', notifError)
      }

      return true
    } catch (error) {
      debug.error('Failed to update report status:', error)
      return false
    }
  }
}

export const reportService = new ReportService()
