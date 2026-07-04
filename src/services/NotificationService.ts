/**
 * NotificationService - Professional unified notification management
 * 
 * Integrates with database's unified notification system while providing:
 * - Local-first notification operations
 * - Consistent error handling and loading states
 * - Integration with send_notification_to_user() database function
 * - Type-safe notification interfaces
 */

import { supabase } from '@/supabase'
import type { Notification, NotificationType, NotificationPreferences } from '@/types'
import { debug } from '@/utils/debug'

export interface NotificationServiceError {
  code: string
  message: string
  details?: any
}

export interface NotificationResult {
  success: boolean
  notificationIds?: string[]
}

export class NotificationService {
  private static instance: NotificationService
  
  static getInstance(): NotificationService {
    if (!this.instance) {
      this.instance = new NotificationService()
    }
    return this.instance
  }

  // NOTIFICATION OPERATIONS (LOCAL-FIRST)

  /**
   * Send notification using unified database system
   */
  async sendNotification(
    type: NotificationType,
    toUserId: string,
    data: Record<string, any>,
    options?: {
      serverId?: string
      channelId?: string
      conversationId?: string
      activityId?: string
      category?: string
    }
  ): Promise<NotificationResult> {
    try {
      debug.log('🔔 Sending notification via unified system:', { type, toUserId, data })

      const { data: result, error } = await supabase.rpc('send_notification_to_user', {
        notification_type: type,
        to_user_id: toUserId,
        notification_data: data,
        server_id: options?.serverId || null,
        channel_id: options?.channelId || null,
        conversation_id: options?.conversationId || null,
        activity_id: options?.activityId || null,
        category: options?.category || null
      })

      if (error) {
        throw this.createError('SEND_FAILED', error.message, error)
      }

      debug.log('✅ Notification sent successfully via unified system')
      return { success: true, notificationIds: result ? [result] : [] }
    } catch (error) {
      debug.error('❌ Failed to send notification:', error)
      throw error
    }
  }

  /**
   * Fetch notifications with pagination
   * Note: Block/mute filtering should be handled by database function get_user_notifications
   */
  async fetchNotifications(
    userId: string,
    options?: {
      limit?: number
      offset?: number
      unreadOnly?: boolean
    }
  ): Promise<Notification[]> {
    try {
      debug.log('🔄 Fetching notifications via service layer:', { userId, options })

      // Fetch notifications using RPC function (should filter blocks/mutes at DB level)
      const { data: notifications, error } = await supabase.rpc('get_user_notifications', {
        p_user_id: userId,
        p_limit: options?.limit || 50,
        p_offset: options?.offset || 0,
        p_unread_only: options?.unreadOnly || false,
        p_notification_types: null
      })

      if (error) {
        // Fallback to direct query if RPC fails
        debug.warn('RPC get_user_notifications failed, falling back to direct query:', error)
        return await this._fetchNotificationsDirect(userId, options)
      }

      debug.log(`✅ Fetched ${notifications?.length || 0} notifications`)
      return notifications || []
    } catch (error) {
      debug.error('❌ Failed to fetch notifications:', error)
      throw error
    }
  }

  /**
   * Fallback direct query method
   */
  private async _fetchNotificationsDirect(
    userId: string,
    options?: {
      limit?: number
      offset?: number
      unreadOnly?: boolean
    }
  ): Promise<Notification[]> {
    let query = supabase
      .from('notifications')
      .select(`
        id,
        user_id,
        type,
        data,
        is_read,
        is_clicked,
        created_at,
        updated_at,
        expires_at,
        read_at
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (options?.unreadOnly) {
      query = query.eq('is_read', false)
    }

    if (options?.limit) {
      query = query.limit(options.limit)
    }

    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 50) - 1)
    }

    const { data: notifications, error } = await query

    if (error) {
      throw this.createError('FETCH_FAILED', error.message, error)
    }

    return notifications || []
  }

  /**
   * Mark notification as read
   */
  async markAsRead(notificationId: string): Promise<boolean> {
    try {
      debug.log('🔄 Marking notification as read:', notificationId)

      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('id', notificationId)

      if (error) {
        throw this.createError('UPDATE_FAILED', error.message, error)
      }

      debug.log('✅ Notification marked as read')
      return true
    } catch (error) {
      debug.error('❌ Failed to mark notification as read:', error)
      throw error
    }
  }

  /**
   * Mark notification as unread
   */
  async markAsUnread(notificationId: string): Promise<boolean> {
    try {
      debug.log('🔄 Marking notification as unread:', notificationId)

      const { error } = await supabase
        .from('notifications')
        .update({ is_read: false, read_at: null })
        .eq('id', notificationId)

      if (error) {
        throw this.createError('UPDATE_FAILED', error.message, error)
      }

      debug.log('✅ Notification marked as unread')
      return true
    } catch (error) {
      debug.error('❌ Failed to mark notification as unread:', error)
      throw error
    }
  }

  /**
   * Mark all notifications as read for user
   */
  async markAllAsRead(userId: string): Promise<boolean> {
    try {
      debug.log('🔄 Marking all notifications as read for user:', userId)

      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('is_read', false)

      if (error) {
        throw this.createError('UPDATE_FAILED', error.message, error)
      }

      debug.log('✅ All notifications marked as read')
      return true
    } catch (error) {
      debug.error('❌ Failed to mark all notifications as read:', error)
      throw error
    }
  }

  /**
   * Delete notification
   */
  async deleteNotification(notificationId: string): Promise<boolean> {
    try {
      debug.log('🔄 Deleting notification:', notificationId)

      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('id', notificationId)

      if (error) {
        throw this.createError('DELETE_FAILED', error.message, error)
      }

      debug.log('✅ Notification deleted')
      return true
    } catch (error) {
      debug.error('❌ Failed to delete notification:', error)
      throw error
    }
  }

  /**
   * Mark every notification for these `(profileId, post_id, type)` tuples
   * as read. Used by the Mentions view to clear notifications as the user
   * actually sees the corresponding posts come into view.
   *
   * Both `activitypub_mention` and `activitypub_reply` triggers store the
   * referenced post's id at `data.post_id` (see 11_functions_triggers.sql).
   * `.filter(...,'in','(a,b,c)')` is the PostgREST escape hatch for JSON
   * path columns that `.in()` doesn't support directly. Post ids are UUIDs
   * (regex-validated upstream), so no quoting is required.
   */
  async markMentionNotificationsForPostsAsRead(
    profileId: string,
    postIds: string[],
    types: string[] = ['activitypub_mention', 'activitypub_reply'],
  ): Promise<boolean> {
    if (!postIds.length) return true
    try {
      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('user_id', profileId)
        .in('type', types)
        .eq('is_read', false)
        .filter('data->>post_id', 'in', `(${postIds.join(',')})`)

      if (error) {
        throw this.createError('UPDATE_FAILED', error.message, error)
      }
      return true
    } catch (error) {
      debug.error('❌ Failed to mark mention notifications as read:', error)
      return false
    }
  }

  /**
   * Delete every notification for the given profile id.
   * RLS already restricts to the caller's notifications, but we also scope
   * by `user_id` so an `eq('user_id', ...)` mismatch fails loudly instead
   * of silently wiping rows for the wrong account.
   */
  async deleteAllNotifications(profileId: string): Promise<boolean> {
    try {
      debug.log('🔄 Deleting all notifications for profile:', profileId)

      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('user_id', profileId)

      if (error) {
        throw this.createError('DELETE_ALL_FAILED', error.message, error)
      }

      debug.log('✅ All notifications deleted')
      return true
    } catch (error) {
      debug.error('❌ Failed to delete all notifications:', error)
      throw error
    }
  }

  /**
   * Get unread notification count
   */
  async getUnreadCount(userId: string): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_read', false)

      if (error) {
        throw this.createError('COUNT_FAILED', error.message, error)
      }

      return count || 0
    } catch (error) {
      debug.error('❌ Failed to get unread count:', error)
      return 0
    }
  }

  /**
   * Load user notification preferences
   */
  async loadPreferences(userId: string): Promise<NotificationPreferences | null> {
    try {
      debug.log('🔄 Loading notification preferences:', userId)

      const { data: preferences, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      if (error && error.code !== 'PGRST116') {
        throw this.createError('LOAD_PREFERENCES_FAILED', error.message, error)
      }

      debug.log('✅ Notification preferences loaded')
      return preferences
    } catch (error) {
      debug.error('❌ Failed to load notification preferences:', error)
      return null
    }
  }

  /**
   * Update user notification preferences
   */
  async updatePreferences(
    userId: string, 
    preferences: Partial<NotificationPreferences>
  ): Promise<NotificationPreferences | null> {
    try {
      debug.log('🔄 Updating notification preferences:', { userId, preferences })

      const { data: updated, error } = await supabase
        .from('notification_preferences')
        .upsert({
          user_id: userId,
          ...preferences,
        }, {
          onConflict: 'user_id'
        })
        .select()
        .single()

      if (error) {
        throw this.createError('UPDATE_PREFERENCES_FAILED', error.message, error)
      }

      debug.log('✅ Notification preferences updated')
      return updated
    } catch (error) {
      debug.error('❌ Failed to update notification preferences:', error)
      throw error
    }
  }

  // HELPER METHODS

  private createError(code: string, message: string, details?: any): NotificationServiceError {
    return {
      code,
      message,
      details
    }
  }
}

// Export singleton instance
export const notificationService = NotificationService.getInstance()
export default NotificationService