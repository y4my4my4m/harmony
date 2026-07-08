/**
 * User Activity Tracker - Professional Discord/Slack-style presence system
 * Tracks user activity and manages automatic status transitions
 */

import { UserStatus } from '@/types'
import { debug } from '@/utils/debug'

export interface ActivityState {
  lastActivity: number
  isIdle: boolean
  isAway: boolean
  wasManuallySet: boolean
  manualStatus: UserStatus | null
}

class ActivityTracker extends EventTarget {
  private lastActivity: number = Date.now()
  private activityCheckTimer: number | null = null
  private isTracking: boolean = false
  
  // Timing constants (in milliseconds)
  private readonly AWAY_THRESHOLD = 5 * 60 * 1000  // 5 minutes
  private readonly OFFLINE_THRESHOLD = 15 * 60 * 1000  // 15 minutes  
  private readonly CHECK_INTERVAL = 30 * 1000  // 30 seconds
  
  // Activity tracking
  private activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart']
  private boundActivityHandler: () => void

  constructor() {
    super()
    this.boundActivityHandler = this.onActivity.bind(this)
  }

  /**
   * Start tracking user activity
   */
  startTracking(): void {
    if (this.isTracking) return
    
    debug.log('Starting activity tracking')
    this.isTracking = true
    this.lastActivity = Date.now()
    
    // Listen for user activity
    this.activityEvents.forEach(event => {
      document.addEventListener(event, this.boundActivityHandler, { passive: true })
    })
    
    this.activityCheckTimer = window.setInterval(() => {
      this.checkActivityStatus()
    }, this.CHECK_INTERVAL)
  }

  /**
   * Stop tracking user activity
   */
  stopTracking(): void {
    if (!this.isTracking) return
    
    debug.log('⏹Stopping activity tracking')
    this.isTracking = false
    
    this.activityEvents.forEach(event => {
      document.removeEventListener(event, this.boundActivityHandler)
    })
    
    if (this.activityCheckTimer) {
      clearInterval(this.activityCheckTimer)
      this.activityCheckTimer = null
    }
  }

  /**
   * Handle user activity event
   */
  private onActivity(): void {
    const now = Date.now()
    const wasInactive = this.isInactive()
    
    this.lastActivity = now
    
    // If user was inactive and now active, emit activity resumed
    if (wasInactive) {
      debug.log('User activity resumed')
      this.dispatchEvent(new CustomEvent('activity-resumed', {
        detail: { timestamp: now }
      }))
    }
  }

  /**
   * Check current activity status and emit events if changed
   */
  private checkActivityStatus(): void {
    const now = Date.now()
    const inactiveTime = now - this.lastActivity
    
    const isAway = inactiveTime >= this.AWAY_THRESHOLD
    const isOffline = inactiveTime >= this.OFFLINE_THRESHOLD
    
    if (isOffline && !this.wasOffline) {
      debug.log('User inactive for 15+ minutes - triggering offline')
      this.wasOffline = true
      this.dispatchEvent(new CustomEvent('status-should-change', {
        detail: { 
          status: UserStatus.Offline, 
          reason: 'inactivity',
          inactiveTime 
        }
      }))
    } else if (isAway && !this.wasAway && !isOffline) {
      debug.log('User inactive for 5+ minutes - triggering away')
      this.wasAway = true
      this.dispatchEvent(new CustomEvent('status-should-change', {
        detail: { 
          status: UserStatus.Away, 
          reason: 'inactivity',
          inactiveTime 
        }
      }))
    }
  }

  // Track previous states to avoid duplicate events
  private wasAway = false
  private wasOffline = false

  /**
   * Reset status tracking (call when user manually changes status)
   */
  resetStatusTracking(): void {
    this.wasAway = false
    this.wasOffline = false
  }

  /**
   * Check if user is currently inactive
   */
  isInactive(): boolean {
    return Date.now() - this.lastActivity >= this.AWAY_THRESHOLD
  }

  /**
   * Get time since last activity
   */
  getTimeSinceLastActivity(): number {
    return Date.now() - this.lastActivity
  }

  /**
   * Get current activity state
   */
  getActivityState(): ActivityState {
    const inactiveTime = Date.now() - this.lastActivity
    
    return {
      lastActivity: this.lastActivity,
      isIdle: inactiveTime >= this.AWAY_THRESHOLD,
      isAway: inactiveTime >= this.AWAY_THRESHOLD,
      wasManuallySet: false, // This will be managed by the status service
      manualStatus: null
    }
  }
}

export const activityTracker = new ActivityTracker()
