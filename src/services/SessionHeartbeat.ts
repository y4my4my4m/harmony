// DISABLED: caused connection issues. Supabase handles keepalive internally; no push notifications configured, so session tracking is unneeded.

import { debug } from '@/utils/debug'

interface ViewContext {
  serverId?: string
  channelId?: string
  conversationId?: string
}

class SessionHeartbeatService {
  private currentContext: ViewContext = {}
  private isInitialized = false

  /**
   * Initialize - NO-OP
   * Supabase handles connection keepalive internally
   */
  async initialize(_userId: string): Promise<void> {
    if (this.isInitialized) return
    this.isInitialized = true
    debug.log('Session Heartbeat: Disabled - Supabase handles connections internally')
  }

  /**
   * Stop - NO-OP
   */
  async stop(): Promise<void> {
    this.isInitialized = false
  }

  /**
   * Update context - just stores locally, no network calls
   */
  updateContext(context: ViewContext): void {
    this.currentContext = context
    debug.log('Session Heartbeat: Context updated', context)
  }

  /**
   * Clear context - NO-OP
   */
  clearContext(): void {
    this.currentContext = {}
  }
}

export const sessionHeartbeat = new SessionHeartbeatService()
