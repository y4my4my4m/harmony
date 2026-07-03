import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { authContextService } from '@/services/AuthContextService'

export interface Announcement {
  id: string
  title: string
  content: string
  image_url?: string
  icon: string
  is_active: boolean
  starts_at: string
  ends_at?: string
  is_pinned: boolean
  show_popup: boolean
  silence: boolean
  created_at: string
  updated_at: string
  author_id?: string
  author_username?: string
  author_display_name?: string
  author_avatar_url?: string
  display_order: number
}

export interface CreateAnnouncementParams {
  title: string
  content: string
  image_url?: string
  icon?: string
  is_pinned?: boolean
  show_popup?: boolean
  silence?: boolean
  starts_at?: string
  // `null` lets admins explicitly clear an existing expiry (i.e. "never
  // expires") on update; `undefined` keeps the current DB value.
  ends_at?: string | null
  display_order?: number
}

class AnnouncementService {
  /**
   * Fetch the current user's unread announcements.
   *
   * Pass `{ popupOnly: true }` for the AnnouncementPopup path - this asks
   * the RPC to additionally filter on `show_popup = true` and to skip any
   * announcement that started before the user signed up, with a hard cap
   * of 10 rows. The default (no options) returns the full unread set and
   * is what the Settings archive + sidebar unread badge use.
   */
  async getUnreadAnnouncements(
    options: { popupOnly?: boolean } = {}
  ): Promise<Announcement[]> {
    try {
      const { authUser: user } = await authContextService.getCurrentContext()
      if (!user) return []

      const { data, error } = await supabase.rpc('get_unread_announcements', {
        p_user_id: user.id,
        p_popup_only: options.popupOnly ?? false,
      })

      if (error) throw error
      return data || []
    } catch (error) {
      debug.error('Failed to get unread announcements:', error)
      return []
    }
  }

  async getAllAnnouncements(): Promise<Announcement[]> {
    try {
      const { data, error } = await supabase
        .from('instance_announcements')
        .select(`
          *,
          author:profiles(username, display_name, avatar_url)
        `)
        .order('created_at', { ascending: false })

      if (error) throw error

      return (data || []).map((a: any) => ({
        ...a,
        author_username: a.author?.username,
        author_display_name: a.author?.display_name,
        author_avatar_url: a.author?.avatar_url
      }))
    } catch (error) {
      debug.error('Failed to get all announcements:', error)
      return []
    }
  }

  async createAnnouncement(params: CreateAnnouncementParams): Promise<Announcement | null> {
    try {
      const { authUser: user } = await authContextService.getCurrentContext()
      if (!user) throw new Error('Not authenticated')

      const { data, error } = await supabase
        .from('instance_announcements')
        .insert({
          ...params,
          author_id: user.id,
          icon: params.icon || 'info',
          is_pinned: params.is_pinned ?? false,
          show_popup: params.show_popup ?? true,
          silence: params.silence ?? false,
          display_order: params.display_order ?? 0
        })
        .select()
        .single()

      if (error) throw error
      return data
    } catch (error) {
      debug.error('Failed to create announcement:', error)
      return null
    }
  }

  async updateAnnouncement(id: string, updates: Partial<CreateAnnouncementParams & { is_active: boolean }>): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('instance_announcements')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)

      if (error) throw error
      return true
    } catch (error) {
      debug.error('Failed to update announcement:', error)
      return false
    }
  }

  async deleteAnnouncement(id: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('instance_announcements')
        .delete()
        .eq('id', id)

      if (error) throw error
      return true
    } catch (error) {
      debug.error('Failed to delete announcement:', error)
      return false
    }
  }

  async markAsRead(announcementId: string): Promise<boolean> {
    try {
      const { authUser: user } = await authContextService.getCurrentContext()
      if (!user) return false

      const { error } = await supabase
        .from('announcement_reads')
        .upsert({
          announcement_id: announcementId,
          user_id: user.id
        }, { onConflict: 'announcement_id,user_id' })

      if (error) throw error
      return true
    } catch (error) {
      debug.error('Failed to mark announcement as read:', error)
      return false
    }
  }

  async markAllAsRead(announcementIds: string[]): Promise<boolean> {
    try {
      const { authUser: user } = await authContextService.getCurrentContext()
      if (!user) return false

      const inserts = announcementIds.map(id => ({
        announcement_id: id,
        user_id: user.id
      }))

      const { error } = await supabase
        .from('announcement_reads')
        .upsert(inserts, { onConflict: 'announcement_id,user_id' })

      if (error) throw error
      return true
    } catch (error) {
      debug.error('Failed to mark all announcements as read:', error)
      return false
    }
  }

  async getUnreadCount(): Promise<number> {
    try {
      const unread = await this.getUnreadAnnouncements()
      return unread.length
    } catch {
      return 0
    }
  }
}

export const announcementService = new AnnouncementService()
