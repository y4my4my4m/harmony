import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'

/**
 * ViewContextTracker - Local cache for current view context
 * 
 * Architecture:
 * - This is the single source of truth for the client's current view
 * - Updated by useViewContext composable when route changes
 * - Used by notification system for immediate client-side suppression checks
 * - Database also handles suppression via is_user_viewing_context() function
 */

export interface ViewContext {
  server_id?: string
  channel_id?: string
  conversation_id?: string
  view_type: 'server_channel' | 'dm' | 'settings' | 'home'
}

export interface NotificationUIDecision {
  showToast: boolean
  showDesktop: boolean
  playSound: boolean
  reason: string
}

const SUPPRESSED: NotificationUIDecision = {
  showToast: false,
  showDesktop: false,
  playSound: false,
  reason: ''
}

const DM_NOTIFICATION_TYPES = new Set(['dm', 'chat_message'])

export class ViewContextTracker {
  private currentContext: ViewContext = {
    view_type: 'home'
  }

  /**
   * Update the current view context
   * Called by useViewContext when user navigates
   */
  updateContext(newContext: ViewContext) {
    debug.log('ViewContext updated:', newContext)
    this.currentContext = { ...newContext }
  }

  /**
   * Get the current view context
   */
  getCurrentContext(): ViewContext {
    return { ...this.currentContext }
  }

  /**
   * Check if user is currently viewing a specific server channel
   */
  isViewingChannel(serverId: string, channelId: string): boolean {
    return (
      this.currentContext.view_type === 'server_channel' &&
      this.currentContext.server_id === serverId &&
      this.currentContext.channel_id === channelId
    )
  }

  /**
   * Check if user is currently in any DM view
   */
  isInDMView(): boolean {
    return this.currentContext.view_type === 'dm'
  }

  /**
   * Get the conversation ID the user is currently viewing (if any)
   */
  getCurrentConversationId(): string | undefined {
    return this.currentContext.view_type === 'dm'
      ? this.currentContext.conversation_id
      : undefined
  }

  /**
   * Check if user is currently viewing a specific DM conversation
   */
  isViewingConversation(conversationId: string): boolean {
    return (
      this.currentContext.view_type === 'dm' &&
      this.currentContext.conversation_id === conversationId
    )
  }

  /**
   * Determines if a notification should show UI elements based on current view context.
   * 
   * For DM notifications, this also accepts an optional `activeConversationId` so
   * callers can supply a fallback conversation ID (e.g. from useDMStore) when the
   * notification payload itself lacks one.
   */
  shouldShowNotificationUI(notificationContext: {
    server_id?: string
    channel_id?: string
    conversation_id?: string
    type: string
  }, activeConversationId?: string): NotificationUIDecision {
    // If user is viewing the exact context where notification originated, suppress
    if (notificationContext.server_id && notificationContext.channel_id) {
      if (this.isViewingChannel(notificationContext.server_id, notificationContext.channel_id)) {
        return { ...SUPPRESSED, reason: 'User is viewing the source channel' }
      }
    }

    // If user is viewing the exact DM conversation, suppress
    if (notificationContext.conversation_id) {
      if (this.isViewingConversation(notificationContext.conversation_id)) {
        return { ...SUPPRESSED, reason: 'User is viewing the source conversation' }
      }
    }

    // Fallback for DM-type notifications with missing conversation_id:
    // Use the caller-supplied activeConversationId (from DM store) to compare
    // against our current view.  This handles malformed notification payloads
    // and federation edge cases where conversation_id is absent.
    if (
      !notificationContext.conversation_id &&
      DM_NOTIFICATION_TYPES.has(notificationContext.type) &&
      this.isInDMView()
    ) {
      const currentConvId = this.currentContext.conversation_id
      if (currentConvId && activeConversationId && currentConvId === activeConversationId) {
        debug.warn('ViewContext: DM notification missing conversation_id, suppressed via activeConversationId fallback')
        return { ...SUPPRESSED, reason: 'User is viewing the source conversation (fallback match)' }
      }
    }

    // User is in a different context - show notifications
    return {
      showToast: true,
      showDesktop: true,
      playSound: true,
      reason: 'User is in different context'
    }
  }

  /**
   * Clear existing unread notifications for the current view context.
   * Called when the user navigates to a channel/DM/post to auto-clear
   * notifications they're now viewing.
   */
  async clearExistingNotificationsForContext(context?: {
    channelId?: string
    conversationId?: string
    postId?: string
    serverId?: string
  }) {
    const ctx = context || {
      channelId: this.currentContext.channel_id,
      conversationId: this.currentContext.conversation_id,
      serverId: this.currentContext.server_id,
    }

    let contextType: string | null = null
    let contextId: string | null = null

    if (ctx.postId) {
      contextType = 'post'
      contextId = ctx.postId
    } else if (ctx.conversationId) {
      contextType = 'conversation'
      contextId = ctx.conversationId
    } else if (ctx.channelId) {
      contextType = 'channel'
      contextId = ctx.channelId
    }

    if (!contextType || !contextId) return

    try {
      const { data, error } = await supabase.rpc('mark_notifications_read_by_context', {
        p_context_type: contextType,
        p_context_id: contextId,
      })

      if (error) {
        debug.warn('Failed to auto-clear notifications for context:', error)
      } else if (data && data > 0) {
        debug.log(`Auto-cleared ${data} notifications for ${contextType}:${contextId}`)
      }
    } catch (error) {
      debug.error('Error clearing notifications for context:', error)
    }
  }

  /**
   * Reset to default state (called on logout)
   */
  reset() {
    this.currentContext = { view_type: 'home' }
    debug.log('ViewContext reset')
  }
}

export const viewContextTracker = new ViewContextTracker()