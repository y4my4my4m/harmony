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
import { debug } from '@/utils/debug'

export interface CallPermissionCheck {
  allowed: boolean
  /**
   * Why the call was disallowed. `'error'` is used when the permission lookup
   * itself failed (DB / RLS / network) - see BUGS.md H4 (fail-closed on error
   * for inbound calls).
   */
  reason?: 'blocked' | 'busy' | 'dnd' | 'muted' | 'notifications_disabled' | 'error'
  message?: string
}

class DMCallPermissionService {
  /**
   * Check if user can receive calls (comprehensive check)
   * Now fully enabled with proper RLS policies on user_blocks table
   */
  async canReceiveCall(
    callerId: string,
    receiverId: string,
    conversationId: string
  ): Promise<CallPermissionCheck> {
    debug.log('🔍 Checking call permissions:', { callerId, receiverId, conversationId })
    
    try {
      // 1. Check if caller is blocked by receiver
      debug.log('🔍 Checking if caller is blocked by receiver...')
      const isBlocked = await this.isUserBlocked(receiverId, callerId)
      debug.log('🔍 Blocked check result:', isBlocked)
      if (isBlocked) {
        return {
          allowed: false,
          reason: 'blocked',
          message: 'You cannot call this user'
        }
      }

      // 2. Check if caller has blocked receiver (shouldn't be able to call)
      debug.log('🔍 Checking if caller has blocked receiver...')
      const hasBlockedReceiver = await this.isUserBlocked(callerId, receiverId)
      debug.log('🔍 Has blocked receiver result:', hasBlockedReceiver)
      if (hasBlockedReceiver) {
        return {
          allowed: false,
          reason: 'blocked',
          message: 'You have blocked this user'
        }
      }

      // 3. Check if receiver is in Do Not Disturb mode
      debug.log('🔍 Checking DND status...')
      const isDND = await this.isUserInDND(receiverId)
      debug.log('🔍 DND check result:', isDND)
      if (isDND) {
        return {
          allowed: false,
          reason: 'dnd',
          message: 'This user is in Do Not Disturb mode'
        }
      }

      // 4. Check if receiver is busy (already in another call)
      debug.log('🔍 Checking busy status...')
      const isBusy = await this.isUserBusy(receiverId)
      debug.log('🔍 Busy check result:', isBusy)
      if (isBusy) {
        return {
          allowed: false,
          reason: 'busy',
          message: 'User is currently in another call'
        }
      }

      // 5. Check if receiver has muted this conversation
      debug.log('🔍 Checking if conversation is muted...')
      const isMuted = await this.isConversationMuted(receiverId, conversationId)
      debug.log('🔍 Muted check result:', isMuted)
      if (isMuted) {
        return {
          allowed: false,
          reason: 'muted',
          message: 'This user has muted this conversation'
        }
      }

      // 6. Check notification preferences
      debug.log('🔍 Checking notification preferences...')
      const notificationsEnabled = await this.areCallNotificationsEnabled(receiverId)
      debug.log('🔍 Notifications enabled result:', notificationsEnabled)
      if (!notificationsEnabled) {
        return {
          allowed: false,
          reason: 'notifications_disabled',
          message: 'This user has disabled call notifications'
        }
      }

      // All checks passed
      debug.log('✅ All permission checks passed - call allowed!')
      return { allowed: true }
    } catch (error) {
      debug.error('❌ Error checking call permissions:', error)
      // BUGS.md H4: previously this failed OPEN on any error, which meant
      // that blocked / DND / muted users would still receive calls whenever
      // the permission lookup hit a DB/RLS error. The cost of a spurious
      // ring on a transient error is far lower than the cost of bypassing
      // a real block, so we now fail closed for inbound calls.
      return {
        allowed: false,
        reason: 'error',
        message: 'Could not verify call permissions - please try again.'
      }
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
        .maybeSingle() // Use maybeSingle instead of single to handle no results

      if (error) {
        debug.warn('⚠️ Error checking block status (RLS?):', error.message)
        // If RLS error, assume not blocked (fail open for calls)
        return false
      }

      return !!data
    } catch (error) {
      debug.warn('⚠️ Exception checking block status:', error)
      // No block found or error - assume not blocked
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
    try {
      const { data, error } = await supabase
        .from('voice_channel_participants')
        .select('id')
        .eq('user_id', userId)
        .limit(1)

      if (error || !data || data.length === 0) return false
      return true
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
        .maybeSingle()

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

