/**
 * Status Lifecycle Debug Utility
 * Test and monitor automatic status transitions
 */

import { userDataService } from '@/services/userDataService'
import { activityTracker } from '@/services/ActivityTracker'
import { UserStatus } from '@/types'
import { debug } from '@/utils/debug'

class StatusLifecycleDebugger {
  private isDebugging = false
  private logHistory: string[] = []
  // BUGS.md M12: stopDebugging() used to reference `this.statusChangedListener`
  // etc., but `startDebugging()` registered ANONYMOUS callbacks and never
  // stored them. Every start/stop pair therefore leaked listeners on
  // userDataService + activityTracker. Store bound references explicitly so
  // removeEventListener actually matches.
  private statusChangedListener: ((event: any) => void) | null = null
  private activityResumedListener: ((event: any) => void) | null = null
  private statusShouldChangeListener: ((event: any) => void) | null = null

  /**
   * Start debug monitoring
   */
  startDebugging(): void {
    if (this.isDebugging) return
    
    debug.log('🔍 Starting status lifecycle debugging')
    this.isDebugging = true
    this.logHistory = []

    this.statusChangedListener = (event: any) => {
      const log = `✅ Status changed: ${UserStatus[event.detail.status]} (User: ${event.detail.userId})`
      debug.log(log)
      this.logHistory.push(`${new Date().toLocaleTimeString()} - ${log}`)
    }
    userDataService.addEventListener('status-changed', this.statusChangedListener)

    this.activityResumedListener = (event: any) => {
      const log = `👋 Activity resumed at ${new Date(event.detail.timestamp).toLocaleTimeString()}`
      debug.log(log)
      this.logHistory.push(`${new Date().toLocaleTimeString()} - ${log}`)
    }
    activityTracker.addEventListener('activity-resumed', this.activityResumedListener)

    this.statusShouldChangeListener = (event: any) => {
      const log = `😴 Auto status change suggested: ${UserStatus[event.detail.status]} (${event.detail.reason})`
      debug.log(log)
      this.logHistory.push(`${new Date().toLocaleTimeString()} - ${log}`)
    }
    activityTracker.addEventListener('status-should-change', this.statusShouldChangeListener)
  }

  /**
   * Stop debug monitoring
   */
  stopDebugging(): void {
    debug.log('⏹️ Stopping status lifecycle debugging')
    this.isDebugging = false

    if (this.statusChangedListener) {
      userDataService.removeEventListener('status-changed', this.statusChangedListener)
      this.statusChangedListener = null
    }

    if (this.activityResumedListener) {
      activityTracker.removeEventListener('activity-resumed', this.activityResumedListener)
      this.activityResumedListener = null
    }

    if (this.statusShouldChangeListener) {
      activityTracker.removeEventListener('status-should-change', this.statusShouldChangeListener)
      this.statusShouldChangeListener = null
    }
  }

  /**
   * Get current status information
   */
  getCurrentStatusInfo(): any {
    const currentUser = userDataService.getCurrentUser()
    const activityState = activityTracker.getActivityState()
    
    return {
      user: currentUser ? {
        id: currentUser.id,
        username: currentUser.username,
        status: UserStatus[currentUser.status],
        lastHeartbeat: currentUser.lastHeartbeat,
        isOnline: currentUser.isOnline
      } : null,
      activity: {
        lastActivity: new Date(activityState.lastActivity).toLocaleTimeString(),
        timeSinceLastActivity: `${Math.round(activityTracker.getTimeSinceLastActivity() / 1000)}s`,
        isIdle: activityState.isIdle,
        isAway: activityState.isAway
      },
      logHistory: this.logHistory.slice(-10) // Last 10 entries
    }
  }

  /**
   * Test manual status changes
   */
  async testManualStatusChange(status: UserStatus): Promise<void> {
    debug.log(`🧪 Testing manual status change to: ${UserStatus[status]}`)
    try {
      await userDataService.updateCurrentUserStatus(status)
      debug.log('✅ Manual status change successful')
    } catch (error) {
      debug.error('❌ Manual status change failed:', error)
    }
  }

  /**
   * Simulate inactivity for testing
   */
  simulateInactivity(minutes: number): void {
    debug.log(`🕐 Simulating ${minutes} minutes of inactivity...`)
    
    // Hack the activity tracker's last activity time
    const millisecondsAgo = minutes * 60 * 1000
    ;(activityTracker as any).lastActivity = Date.now() - millisecondsAgo
    
    debug.log(`⏰ Last activity set to ${minutes} minutes ago`)
  }

  /**
   * Show debug panel in console
   */
  showDebugPanel(): void {
    const info = this.getCurrentStatusInfo()
    
    console.group('🔍 Status Lifecycle Debug Panel')
    debug.log('Current User:', info.user)
    debug.log('Activity State:', info.activity)
    debug.log('Recent Log History:')
    info.logHistory.forEach((entry: string) => debug.log('  ' + entry))
    console.groupEnd()
  }
}

// Export singleton
export const statusDebugger = new StatusLifecycleDebugger()

// Make it globally available for console testing
if (typeof window !== 'undefined') {
  ;(window as any).statusDebugger = statusDebugger
  ;(window as any).testStatus = async (status: string) => {
    const statusEnum = UserStatus[status as keyof typeof UserStatus]
    if (statusEnum !== undefined) {
      await statusDebugger.testManualStatusChange(statusEnum)
      return `✅ Status changed to ${status}`
    } else {
      const available = Object.keys(UserStatus).filter(k => isNaN(Number(k)))
      debug.log('Available statuses:', available)
      return `❌ Invalid status. Available: ${available.join(', ')}`
    }
  }
  ;(window as any).showStatusDebug = () => statusDebugger.showDebugPanel()
  ;(window as any).simulateInactivity = (minutes: number = 6) => {
    if (!minutes || isNaN(minutes)) {
      debug.log('❌ Please provide a number of minutes. Example: simulateInactivity(6)')
      return
    }
    statusDebugger.simulateInactivity(minutes)
    return `⏰ Simulated ${minutes} minutes of inactivity`
  }
  
  // Additional helpful functions
  ;(window as any).resetActivity = () => {
    ;(activityTracker as any).lastActivity = Date.now()
    activityTracker.resetStatusTracking()
    return '🔄 Activity reset to now'
  }
  
  ;(window as any).showHelp = () => {
    console.group('🔍 Status Debug Commands')
    debug.log('showStatusDebug() - Show current status and activity info')
    debug.log('testStatus("Away") - Test manual status change')
    debug.log('simulateInactivity(6) - Simulate 6 minutes of inactivity')
    debug.log('resetActivity() - Reset activity tracker to now')
    debug.log('Available statuses: Online, Away, Busy, Offline')
    console.groupEnd()
    return 'Help displayed above ☝️'
  }
}
