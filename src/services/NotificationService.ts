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

  // =====================================================
  // NOTIFICATION OPERATIONS (LOCAL-FIRST)
  // =====================================================

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
      console.log('🔔 Sending notification via unified system:', { type, toUserId, data })

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

      console.log('✅ Notification sent successfully via unified system')
      return { success: true, notificationIds: result ? [result] : [] }
    } catch (error) {
      console.error('❌ Failed to send notification:', error)
      throw error
    }
  }

  /**
   * Fetch notifications with pagination
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
      console.log('🔄 Fetching notifications via service layer:', { userId, options })

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

      console.log(`✅ Fetched ${notifications?.length || 0} notifications`)
      return notifications || []
    } catch (error) {
      console.error('❌ Failed to fetch notifications:', error)
      throw error
    }
  }

  /**
   * Mark notification as read
   */
  async markAsRead(notificationId: string): Promise<boolean> {
    try {
      console.log('🔄 Marking notification as read:', notificationId)

      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('id', notificationId)

      if (error) {
        throw this.createError('UPDATE_FAILED', error.message, error)
      }

      console.log('✅ Notification marked as read')
      return true
    } catch (error) {
      console.error('❌ Failed to mark notification as read:', error)
      throw error
    }
  }

  /**
   * Mark all notifications as read for user
   */
  async markAllAsRead(userId: string): Promise<boolean> {
    try {
      console.log('🔄 Marking all notifications as read for user:', userId)

      const { error } = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', userId)
        .eq('is_read', false)

      if (error) {
        throw this.createError('UPDATE_FAILED', error.message, error)
      }

      console.log('✅ All notifications marked as read')
      return true
    } catch (error) {
      console.error('❌ Failed to mark all notifications as read:', error)
      throw error
    }
  }

  /**
   * Delete notification
   */
  async deleteNotification(notificationId: string): Promise<boolean> {
    try {
      console.log('🔄 Deleting notification:', notificationId)

      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('id', notificationId)

      if (error) {
        throw this.createError('DELETE_FAILED', error.message, error)
      }

      console.log('✅ Notification deleted')
      return true
    } catch (error) {
      console.error('❌ Failed to delete notification:', error)
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
      console.error('❌ Failed to get unread count:', error)
      return 0
    }
  }

  /**
   * Load user notification preferences
   */
  async loadPreferences(userId: string): Promise<NotificationPreferences | null> {
    try {
      console.log('🔄 Loading notification preferences:', userId)

      const { data: preferences, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .single()

      if (error && error.code !== 'PGRST116') {
        throw this.createError('LOAD_PREFERENCES_FAILED', error.message, error)
      }

      console.log('✅ Notification preferences loaded')
      return preferences
    } catch (error) {
      console.error('❌ Failed to load notification preferences:', error)
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
      console.log('🔄 Updating notification preferences:', { userId, preferences })

      const { data: updated, error } = await supabase
        .from('notification_preferences')
        .upsert({
          user_id: userId,
          ...preferences,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id'
        })
        .select()
        .single()

      if (error) {
        throw this.createError('UPDATE_PREFERENCES_FAILED', error.message, error)
      }

      console.log('✅ Notification preferences updated')
      return updated
    } catch (error) {
      console.error('❌ Failed to update notification preferences:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

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