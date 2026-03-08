import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

export interface Report {
  id: string
  reporter_id: string
  reported_user_id?: string
  reported_post_id?: string
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

export interface CreateReportParams {
  reported_user_id?: string
  reported_post_id?: string
  report_type: 'user' | 'post' | 'message' | 'server'
  reason: string
  comment?: string
}

export type ReportReason =
  | 'spam'
  | 'harassment'
  | 'hate_speech'
  | 'illegal_content'
  | 'misinformation'
  | 'impersonation'
  | 'nsfw'
  | 'other'

export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'spam', label: 'Spam or unwanted content' },
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'hate_speech', label: 'Hate speech' },
  { value: 'illegal_content', label: 'Illegal content' },
  { value: 'misinformation', label: 'Misinformation' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'nsfw', label: 'Inappropriate/NSFW content' },
  { value: 'other', label: 'Other' }
]

class ReportService {
  async createReport(params: CreateReportParams): Promise<Report | null> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not authenticated')

      const { data, error } = await supabase
        .from('reports')
        .insert({
          reporter_id: user.id,
          reported_user_id: params.reported_user_id,
          reported_post_id: params.reported_post_id,
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
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return []

      const { data, error } = await supabase
        .from('reports')
        .select('*')
        .eq('reporter_id', user.id)
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
    status?: string
    limit?: number
    offset?: number
  } = {}): Promise<{ reports: Report[]; total: number }> {
    try {
      const { status = 'pending', limit = 25, offset = 0 } = options

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
    resolutionNotes?: string
  ): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('reports')
        .update({
          status,
          updated_at: new Date().toISOString(),
          metadata: resolutionNotes
            ? { resolution_notes: resolutionNotes }
            : undefined
        })
        .eq('id', reportId)

      if (error) throw error
      return true
    } catch (error) {
      debug.error('Failed to update report status:', error)
      return false
    }
  }
}

export const reportService = new ReportService()
