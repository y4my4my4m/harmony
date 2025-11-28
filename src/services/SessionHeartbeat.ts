/**
 * Session Heartbeat Service
 * 
 * Tracks user's active session for smart push notifications (Discord-like behavior)
 * - Sends periodic heartbeats to indicate user is active
 * - Tracks current viewing context (server, channel, conversation)
 * - Detects device info (platform, form factor, PWA status)
 */

import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

interface DeviceInfo {
  platform: 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'web'
  formFactor: 'mobile' | 'tablet' | 'desktop'
  isPWA: boolean
  browser: string
  userAgent: string
}

interface ViewContext {
  serverId?: string
  channelId?: string
  conversationId?: string
}

class SessionHeartbeatService {
  private sessionToken: string | null = null
  private userId: string | null = null
  private heartbeatInterval: NodeJS.Timeout | null = null
  private deviceInfo: DeviceInfo | null = null
  private currentContext: ViewContext = {}
  private isInitialized = false

  // Heartbeat every 30 seconds
  private readonly HEARTBEAT_INTERVAL = 30 * 1000

  /**
   * Initialize the session heartbeat for a user
   */
  async initialize(userId: string): Promise<void> {
    // Already initialized for this user - skip
    if (this.isInitialized && this.userId === userId) {
      return
    }

    // If reinitializing for a different user, clean up first
    if (this.isInitialized) {
      await this.stop()
    }

    this.userId = userId
    this.sessionToken = this.generateSessionToken()
    this.deviceInfo = this.detectDeviceInfo()
    
    debug.log('🫀 Session Heartbeat: Initializing', {
      userId,
      deviceInfo: this.deviceInfo
    })

    // Send initial heartbeat
    await this.sendHeartbeat()

    // Start periodic heartbeats
    this.startHeartbeat()

    // Handle page visibility changes
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    
    // Handle page unload (end session)
    window.addEventListener('beforeunload', this.handleBeforeUnload)

    this.isInitialized = true
    debug.log('✅ Session Heartbeat: Initialized')
  }

  /**
   * Stop the session heartbeat
   */
  async stop(): Promise<void> {
    if (!this.isInitialized) return

    debug.log('⏹️ Session Heartbeat: Stopping')

    // Clear interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    // Remove listeners
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.removeEventListener('beforeunload', this.handleBeforeUnload)

    // End session in database
    await this.endSession()

    this.isInitialized = false
    this.userId = null
  }

  /**
   * Update the current viewing context
   * Call this when user navigates to a different channel/conversation
   */
  updateContext(context: ViewContext): void {
    this.currentContext = context
    
    debug.log('📍 Session Heartbeat: Context updated', context)
    
    // Send immediate heartbeat with new context
    this.sendHeartbeat()
  }

  /**
   * Clear the current context (user left channel/conversation)
   */
  clearContext(): void {
    this.currentContext = {}
    this.sendHeartbeat()
  }

  /**
   * Generate a unique session token
   */
  private generateSessionToken(): string {
    const timestamp = Date.now().toString(36)
    const randomPart = Math.random().toString(36).substring(2, 15)
    const browserPart = navigator.userAgent.slice(0, 10).replace(/\W/g, '')
    return `${timestamp}-${randomPart}-${browserPart}`
  }

  /**
   * Detect device information from browser
   */
  private detectDeviceInfo(): DeviceInfo {
    const ua = navigator.userAgent.toLowerCase()
    
    // Detect platform (OS)
    let platform: DeviceInfo['platform'] = 'web'
    if (/iphone|ipad|ipod/.test(ua)) {
      platform = 'ios'
    } else if (/android/.test(ua)) {
      platform = 'android'
    } else if (/windows/.test(ua)) {
      platform = 'windows'
    } else if (/macintosh|mac os x/.test(ua)) {
      platform = 'macos'
    } else if (/linux/.test(ua)) {
      platform = 'linux'
    } else if (/cros/.test(ua)) {
      platform = 'chromeos'
    }

    // Detect form factor
    let formFactor: DeviceInfo['formFactor'] = 'desktop'
    const isMobile = /iphone|ipod|android.*mobile|windows phone|blackberry/.test(ua)
    const isTablet = /ipad|android(?!.*mobile)|tablet/.test(ua)
    
    if (isMobile) {
      formFactor = 'mobile'
    } else if (isTablet) {
      formFactor = 'tablet'
    }

    // Detect if PWA (installed to home screen)
    const isPWA = this.detectPWA()

    // Detect browser
    let browser = 'unknown'
    if (/edg/.test(ua)) {
      browser = 'edge'
    } else if (/chrome/.test(ua) && !/edg/.test(ua)) {
      browser = 'chrome'
    } else if (/firefox/.test(ua)) {
      browser = 'firefox'
    } else if (/safari/.test(ua) && !/chrome/.test(ua)) {
      browser = 'safari'
    } else if (/opera|opr/.test(ua)) {
      browser = 'opera'
    }

    return {
      platform,
      formFactor,
      isPWA,
      browser,
      userAgent: navigator.userAgent.substring(0, 500) // Limit length
    }
  }

  /**
   * Detect if running as installed PWA
   */
  private detectPWA(): boolean {
    // Check for standalone mode (installed PWA)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    
    // Check for iOS standalone (added to home screen)
    const isIOSStandalone = (navigator as any).standalone === true
    
    // Check for fullscreen mode (some PWAs use this)
    const isFullscreen = window.matchMedia('(display-mode: fullscreen)').matches

    return isStandalone || isIOSStandalone || isFullscreen
  }

  /**
   * Start periodic heartbeat
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }

    this.heartbeatInterval = setInterval(() => {
      // Only send heartbeat if page is visible
      if (document.visibilityState === 'visible') {
        this.sendHeartbeat()
      }
    }, this.HEARTBEAT_INTERVAL)
  }

  /**
   * Send heartbeat to database
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.userId || !this.sessionToken || !this.deviceInfo) {
      return
    }

    try {
      const { error } = await supabase.rpc('upsert_user_session', {
        p_user_id: this.userId,
        p_session_token: this.sessionToken,
        p_platform: this.deviceInfo.platform,
        p_form_factor: this.deviceInfo.formFactor,
        p_is_pwa: this.deviceInfo.isPWA,
        p_browser: this.deviceInfo.browser,
        p_user_agent: this.deviceInfo.userAgent,
        p_status: 'online',
        p_server_id: this.currentContext.serverId || null,
        p_channel_id: this.currentContext.channelId || null,
        p_conversation_id: this.currentContext.conversationId || null
      })

      if (error) {
        debug.warn('💔 Session Heartbeat failed:', error)
      } else {
        debug.log('💓 Session Heartbeat sent')
      }
    } catch (error) {
      debug.error('❌ Session Heartbeat error:', error)
    }
  }

  /**
   * End session in database
   */
  private async endSession(): Promise<void> {
    if (!this.sessionToken) return

    try {
      await supabase.rpc('end_user_session', {
        p_session_token: this.sessionToken
      })
      debug.log('👋 Session ended')
    } catch (error) {
      debug.error('Error ending session:', error)
    }
  }

  /**
   * Handle page visibility changes
   * Pause heartbeat when tab is hidden, resume when visible
   */
  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      debug.log('👁️ Page visible - sending heartbeat')
      this.sendHeartbeat()
    } else {
      debug.log('🙈 Page hidden - skipping heartbeats')
    }
  }

  /**
   * Handle page unload (close tab/window)
   */
  private handleBeforeUnload = (): void => {
    // Use sendBeacon for reliable delivery during page unload
    if (this.sessionToken && navigator.sendBeacon) {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/end_user_session`
      const data = JSON.stringify({ p_session_token: this.sessionToken })
      
      navigator.sendBeacon(url, new Blob([data], { type: 'application/json' }))
    }
  }
}

// Export singleton instance
export const sessionHeartbeat = new SessionHeartbeatService()

