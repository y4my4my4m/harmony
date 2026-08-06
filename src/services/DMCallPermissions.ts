/**
 * DM Call Permission Service
 *
 * Gates call initiation on block status, busy status (already in a call),
 * Do Not Disturb, conversation mute and notification preferences.
 */

import { supabase } from '@/supabase'
import { UserStatus } from '@/types'
import { userDataService } from '@/services/userDataService'
import { debug } from '@/utils/debug'

export interface CallPermissionCheck {
  allowed: boolean
  /**
   * Why the call was disallowed. `'error'` means the permission lookup itself
   * failed (DB / RLS / network); inbound calls fail closed. See BUGS.md H4.
   */
  reason?: 'blocked' | 'busy' | 'dnd' | 'muted' | 'notifications_disabled' | 'error'
  message?: string
}

class DMCallPermissionService {
  /**
   * Runs every gate in order and returns on the first denial.
   * Requires RLS policies on user_blocks for the block lookups to resolve.
   */
  async canReceiveCall(
    callerId: string,
    receiverId: string,
    conversationId: string
  ): Promise<CallPermissionCheck> {
    debug.log('Checking call permissions:', { callerId, receiverId, conversationId })
    
    try {
      debug.log('Checking if caller is blocked by receiver...')
      const isBlocked = await this.isUserBlocked(receiverId, callerId)
      debug.log('Blocked check result:', isBlocked)
      if (isBlocked) {
        return {
          allowed: false,
          reason: 'blocked',
          message: 'You cannot call this user'
        }
      }

      debug.log('Checking if caller has blocked receiver...')
      const hasBlockedReceiver = await this.isUserBlocked(callerId, receiverId)
      debug.log('Has blocked receiver result:', hasBlockedReceiver)
      if (hasBlockedReceiver) {
        return {
          allowed: false,
          reason: 'blocked',
          message: 'You have blocked this user'
        }
      }

      debug.log('Checking DND status...')
      const isDND = await this.isUserInDND(receiverId)
      debug.log('DND check result:', isDND)
      if (isDND) {
        return {
          allowed: false,
          reason: 'dnd',
          message: 'This user is in Do Not Disturb mode'
        }
      }

      debug.log('Checking busy status...')
      const isBusy = await this.isUserBusy(receiverId)
      debug.log('Busy check result:', isBusy)
      if (isBusy) {
        return {
          allowed: false,
          reason: 'busy',
          message: 'User is currently in another call'
        }
      }

      debug.log('Checking if conversation is muted...')
      const isMuted = await this.isConversationMuted(receiverId, conversationId)
      debug.log('Muted check result:', isMuted)
      if (isMuted) {
        return {
          allowed: false,
          reason: 'muted',
          message: 'This user has muted this conversation'
        }
      }

      debug.log('Checking notification preferences...')
      const notificationsEnabled = await this.areCallNotificationsEnabled(receiverId)
      debug.log('Notifications enabled result:', notificationsEnabled)
      if (!notificationsEnabled) {
        return {
          allowed: false,
          reason: 'notifications_disabled',
          message: 'This user has disabled call notifications'
        }
      }

      debug.log('All permission checks passed - call allowed!')
      return { allowed: true }
    } catch (error) {
      debug.error('Error checking call permissions:', error)
      // BUGS.md H4: inbound calls fail closed. Failing open on a DB/RLS error
      // let blocked / DND / muted users be rung anyway.
      return {
        allowed: false,
        reason: 'error',
        message: 'Could not verify call permissions - please try again.'
      }
    }
  }

  private async isUserBlocked(blockerId: string, blockedUserId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('user_blocks')
        .select('id')
        .eq('blocker_id', blockerId)
        .eq('blocked_user_id', blockedUserId)
        .maybeSingle() // maybeSingle: zero rows is not an error

      if (error) {
        debug.warn('Error checking block status (RLS?):', error.message)
        // RLS failure reads as "not blocked"; canReceiveCall() is the fail-closed gate.
        return false
      }

      return !!data
    } catch (error) {
      debug.warn('Exception checking block status:', error)
      return false
    }
  }

  /** Do Not Disturb is UserStatus.Busy on the profile. */
  private async isUserInDND(userId: string): Promise<boolean> {
    const userData = userDataService.getUser(userId)
    
    if (!userData) {
      // Cache miss - read the profile directly.
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

  /** Busy means present in any voice channel, not only a DM call. */
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

  private async areCallNotificationsEnabled(userId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('notification_preferences')
        .select('sound_voice_activity, desktop_notifications')
        .eq('user_id', userId)
        .maybeSingle()

      if (error || !data) {
        // No preferences row: notifications default on.
        return true
      }

      return data.sound_voice_activity || data.desktop_notifications
    } catch {
      return true
    }
  }

  /** Caller-facing text; deliberately vague for 'blocked' so blocks stay hidden. */
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

export const dmCallPermissions = new DMCallPermissionService()

