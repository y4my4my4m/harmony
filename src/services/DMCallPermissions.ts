/**
 * DM Call Permission Service
 *
 * Two gates. canPlaceCall runs on the caller before ringing: blocks either way
 * and the receiver's Do Not Disturb. canReceiveCall runs on the client that was
 * rung, against its own state: blocks, Do Not Disturb, busy (already in another
 * DM call), call notification preference, and mute, which silences the ring
 * instead of refusing it.
 */

import { supabase } from '@/supabase'
import { UserStatus } from '@/types'
import { userDataService } from '@/services/userDataService'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { debug } from '@/utils/debug'

export interface CallPermissionCheck {
  allowed: boolean
  /**
   * Why the call was disallowed. `'error'` means a block lookup failed (DB /
   * RLS / network); inbound calls fail closed. See BUGS.md H4.
   */
  reason?: 'blocked' | 'busy' | 'dnd' | 'notifications_disabled' | 'error'
  message?: string
  /** Allowed with no ringtone and no incoming-call popup: the receiver muted the conversation or the caller. */
  silent?: boolean
}

class DMCallPermissionService {
  /**
   * Caller-side gate. Busy and mute are absent: only the receiver's client
   * knows it is in a DM call, and mute silences the receiver without refusing.
   */
  async canPlaceCall(callerId: string, receiverId: string): Promise<CallPermissionCheck> {
    // A failed lookup lets the ring through; ring_dm_call skips blocked receivers server-side.
    const blocked = (blockerId: string, blockedId: string) =>
      this.isUserBlocked(blockerId, blockedId).catch((error) => {
        debug.warn('Block lookup failed:', error)
        return false
      })

    if (await blocked(receiverId, callerId)) {
      return { allowed: false, reason: 'blocked', message: 'You cannot call this user' }
    }
    if (await blocked(callerId, receiverId)) {
      return { allowed: false, reason: 'blocked', message: 'You have blocked this user' }
    }
    if (await this.isUserInDND(receiverId)) {
      return { allowed: false, reason: 'dnd', message: 'This user is in Do Not Disturb mode' }
    }
    return { allowed: true }
  }

  /**
   * Receiver-side gate, run by the client that was rung. Returns on the first
   * refusal; a muted caller or conversation is allowed with `silent`.
   */
  async canReceiveCall(
    callerId: string,
    receiverId: string,
    conversationId: string
  ): Promise<CallPermissionCheck> {
    try {
      if (await this.isUserBlocked(receiverId, callerId)) {
        return { allowed: false, reason: 'blocked', message: 'You cannot call this user' }
      }
      if (await this.isUserBlocked(callerId, receiverId)) {
        return { allowed: false, reason: 'blocked', message: 'You have blocked this user' }
      }
      if (await this.isUserInDND(receiverId)) {
        return { allowed: false, reason: 'dnd', message: 'This user is in Do Not Disturb mode' }
      }
      if (await this.isInOtherDMCall(conversationId)) {
        return { allowed: false, reason: 'busy', message: 'User is currently in another call' }
      }
      if (!(await this.areCallNotificationsEnabled(receiverId))) {
        return { allowed: false, reason: 'notifications_disabled', message: 'This user has disabled call notifications' }
      }
      if (await this.isCallMuted(receiverId, callerId, conversationId)) {
        return { allowed: true, silent: true }
      }
      return { allowed: true }
    } catch (error) {
      debug.error('Error checking call permissions:', error)
      // BUGS.md H4: inbound calls fail closed. Failing open on a DB/RLS error
      // let blocked users be rung anyway.
      return {
        allowed: false,
        reason: 'error',
        message: 'Could not verify call permissions - please try again.'
      }
    }
  }

  /** Throws when the lookup fails; each gate picks its own failure direction. */
  private async isUserBlocked(blockerId: string, blockedUserId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('user_blocks')
      .select('id')
      .eq('blocker_id', blockerId)
      .eq('blocked_user_id', blockedUserId)
      .maybeSingle()

    if (error) throw error
    return !!data
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

  /**
   * In, or joining, a DM call (direct or group) of another conversation. A
   * server voice channel is not busy: answering leaves it.
   */
  private async isInOtherDMCall(conversationId: string): Promise<boolean> {
    const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
    const voiceStore = useUnifiedVoiceChannelStore()
    const room = voiceStore.effectiveChannelId
    if (voiceStore.effectiveServerId !== 'dm' || !room) return false
    const current = room.startsWith('federated-dm-')
      ? dmCallSignaling.conversationForRoom(room)
      : room.replace(/^dm-/, '')
    return current !== conversationId
  }

  /**
   * Conversation mute (notification_channels row of the conversation) or a
   * mute of the caller (user_mutes with hide_notifications), as the
   * notification path reads them. A failed lookup reads as not muted.
   */
  private async isCallMuted(receiverId: string, callerId: string, conversationId: string): Promise<boolean> {
    const live = (until: string | null | undefined) => !until || new Date(until).getTime() > Date.now()
    try {
      const [conversation, user] = await Promise.all([
        supabase
          .from('notification_channels')
          .select('muted, muted_until')
          .eq('user_id', receiverId)
          .eq('conversation_id', conversationId)
          .is('channel_id', null)
          .maybeSingle(),
        supabase
          .from('user_mutes')
          .select('expires_at')
          .eq('muter_id', receiverId)
          .eq('muted_user_id', callerId)
          .eq('hide_notifications', true)
          .maybeSingle(),
      ])
      if (conversation.error) debug.warn('Conversation mute lookup failed:', conversation.error.message)
      if (user.error) debug.warn('User mute lookup failed:', user.error.message)

      const conversationMuted = conversation.data?.muted === true && live(conversation.data.muted_until)
      const callerMuted = !!user.data && live(user.data.expires_at)
      return conversationMuted || callerMuted
    } catch (error) {
      debug.warn('Mute lookup failed:', error)
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

  /**
   * Caller-facing text; deliberately vague for 'blocked' so blocks stay hidden.
   * 'muted' arrives from receivers on clients that refused muted calls.
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

export const dmCallPermissions = new DMCallPermissionService()
