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

class ViewContextTracker {
  private currentContext: ViewContext = {
    view_type: 'home'
  }

  updateContext(newContext: ViewContext) {
    console.log('🎯 ViewContext updated:', newContext)
    this.currentContext = { ...newContext }
  }

  getCurrentContext(): ViewContext {
    return { ...this.currentContext }
  }

  /**
   * Determines if a notification should show UI elements based on current view context
   */
  shouldShowNotificationUI(notificationContext: {
    server_id?: string
    channel_id?: string
    conversation_id?: string
    type: string
  }): NotificationUIDecision {
    const current = this.currentContext

    // If user is viewing the exact context where notification originated, suppress all notifications
    if (current.view_type === 'server_channel' && 
        current.server_id === notificationContext.server_id &&
        current.channel_id === notificationContext.channel_id) {
      return {
        showToast: false,
        showDesktop: false,
        playSound: false,
        reason: 'User is viewing the source channel'
      }
    }

    // If user is viewing the exact DM conversation, suppress all notifications
    if (current.view_type === 'dm' && 
        current.conversation_id === notificationContext.conversation_id) {
      return {
        showToast: false,
        showDesktop: false,
        playSound: false,
        reason: 'User is viewing the source conversation'
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

  reset() {
    this.currentContext = { view_type: 'home' }
    console.log('🎯 ViewContext reset')
  }
}

export const viewContextTracker = new ViewContextTracker()