import { debug } from '@/utils/debug'

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

export class ViewContextTracker {
  private currentContext: ViewContext = {
    view_type: 'home'
  }

  /**
   * Update the current view context
   * Called by useViewContext when user navigates
   */
  updateContext(newContext: ViewContext) {
    debug.log('🎯 ViewContext updated:', newContext)
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
   * Check if user is currently viewing a specific DM conversation
   */
  isViewingConversation(conversationId: string): boolean {
    return (
      this.currentContext.view_type === 'dm' &&
      this.currentContext.conversation_id === conversationId
    )
  }

  /**
   * Determines if a notification should show UI elements based on current view context
   * Note: Database also filters at send_notification_to_user level, this is a client-side fallback
   */
  shouldShowNotificationUI(notificationContext: {
    server_id?: string
    channel_id?: string
    conversation_id?: string
    type: string
  }): NotificationUIDecision {
    // If user is viewing the exact context where notification originated, suppress
    if (notificationContext.server_id && notificationContext.channel_id) {
      if (this.isViewingChannel(notificationContext.server_id, notificationContext.channel_id)) {
        return {
          showToast: false,
          showDesktop: false,
          playSound: false,
          reason: 'User is viewing the source channel'
        }
      }
    }

    // If user is viewing the exact DM conversation, suppress
    if (notificationContext.conversation_id) {
      if (this.isViewingConversation(notificationContext.conversation_id)) {
        return {
          showToast: false,
          showDesktop: false,
          playSound: false,
          reason: 'User is viewing the source conversation'
        }
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
   * Reset to default state (called on logout)
   */
  reset() {
    this.currentContext = { view_type: 'home' }
    debug.log('🎯 ViewContext reset')
  }
}

export const viewContextTracker = new ViewContextTracker()