/**
 * DM Call Permission Service
 * Checks if a call can be initiated based on:
 * - Block status
 * - Busy status (already in call)
 * - Do Not Disturb status
 * - Notification preferences
 * - Mute settings
 */

import { supabase } from '@/supabase'
import { UserStatus } from '@/types'
import { userDataService } from '@/services/userDataService'

export interface CallPermissionCheck {
  allowed: boolean
  reason?: 'blocked' | 'busy' | 'dnd' | 'muted' | 'notifications_disabled'
  message?: string
}

class DMCallPermissionService {
  /**
   * Check if user can receive calls (comprehensive check)
   */
  async canReceiveCall(
    callerId: string,
    receiverId: string,
    conversationId: string
  ): Promise<CallPermissionCheck> {
    try {
      // 1. Check if caller is blocked by receiver
      const isBlocked = await this.isUserBlocked(callerId, receiverId)
      if (isBlocked) {
        return {
          allowed: false,
          reason: 'blocked',
          message: 'You cannot call this user'
        }
      }

      // 2. Check if caller has blocked receiver (shouldn't be able to call)
      const hasBlockedReceiver = await this.isUserBlocked(receiverId, callerId)
      if (hasBlockedReceiver) {
        return {
          allowed: false,
          reason: 'blocked',
          message: 'You have blocked this user'
        }
      }

      // 3. Check if receiver is in Do Not Disturb mode
      const isDND = await this.isUserInDND(receiverId)
      if (isDND) {
        return {
          allowed: false,
          reason: 'dnd',
          message: 'This user is in Do Not Disturb mode'
        }
      }

      // 4. Check if receiver is busy (already in another call)
      const isBusy = await this.isUserBusy(receiverId)
      if (isBusy) {
        return {
          allowed: false,
          reason: 'busy',
          message: 'User is currently in another call'
        }
      }

      // 5. Check if receiver has muted this conversation
      const isMuted = await this.isConversationMuted(receiverId, conversationId)
      if (isMuted) {
        return {
          allowed: false,
          reason: 'muted',
          message: 'This user has muted this conversation'
        }
      }

      // 6. Check notification preferences
      const notificationsEnabled = await this.areCallNotificationsEnabled(receiverId)
      if (!notificationsEnabled) {
        return {
          allowed: false,
          reason: 'notifications_disabled',
          message: 'This user has disabled call notifications'
        }
      }

      // All checks passed
      return { allowed: true }
    } catch (error) {
      console.error('Error checking call permissions:', error)
      // On error, allow the call (fail open)
      return { allowed: true }
    }
  }

  /**
   * Check if user A has blocked user B
   */
  private async isUserBlocked(blockerId: string, blockedUserId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('user_blocks')
        .select('id')
        .eq('blocker_id', blockerId)
        .eq('blocked_user_id', blockedUserId)
        .single()

      return !!data && !error
    } catch (error) {
      // No block found or error
      return false
    }
  }

  /**
   * Check if user is in Do Not Disturb mode (Busy status)
   */
  private async isUserInDND(userId: string): Promise<boolean> {
    const userData = userDataService.getUser(userId)
    
    if (!userData) {
      // Fallback to database
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('status')
          .eq('id', userId)
          .single()

        if (error || !data) return false
        return data.status === UserStatus.Busy
      } catch {
        return false
      }
    }

    return userData.status === UserStatus.Busy
  }

  /**
   * Check if user is already in a call
   */
  private async isUserBusy(userId: string): Promise<boolean> {
    // Check if user is in any voice channel
    try {
      const { data, error } = await supabase
        .from('user_presence')
        .select('voice_channel_id')
        .eq('user_id', userId)
        .eq('server_id', 'dm') // Check DM calls
        .single()

      if (error || !data) return false
      return !!data.voice_channel_id
    } catch {
      return false
    }
  }

  /**
   * Check if conversation is muted by user
   */
  private async isConversationMuted(userId: string, conversationId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('conversation_participants')
        .select('is_muted')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .single()

      if (error || !data) return false
      return data.is_muted || false
    } catch {
      return false
    }
  }

  /**
   * Check if user has call notifications enabled
   */
  private async areCallNotificationsEnabled(userId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('notification_preferences')
        .select('sound_voice_activity, desktop_notifications')
        .eq('user_id', userId)
        .single()

      if (error || !data) {
        // Default to enabled if no preferences found
        return true
      }

      // Call notifications enabled if either sound OR desktop notifications are on
      return data.sound_voice_activity || data.desktop_notifications
    } catch {
      // Default to enabled on error
      return true
    }
  }

  /**
   * Get friendly decline reason message for caller
   */
  getDeclineReasonMessage(reason?: string): string {
    switch (reason) {
      case 'blocked':
        return 'Call cannot be completed'
      case 'busy':
        return 'User is busy'
      case 'dnd':
        return 'User is in Do Not Disturb mode'
      case 'muted':
        return 'User has muted this conversation'
      case 'notifications_disabled':
        return 'User has call notifications disabled'
      case 'timeout':
        return 'No answer'
      default:
        return 'Call declined'
    }
  }
}

// Singleton instance
export const dmCallPermissions = new DMCallPermissionService()

