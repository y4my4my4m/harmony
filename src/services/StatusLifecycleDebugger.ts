/**
 * Status Lifecycle Debug Utility
 * Test and monitor automatic status transitions
 */

import { userDataService } from '@/services/userDataService'
import { activityTracker } from '@/services/ActivityTracker'
import { UserStatus } from '@/types'

class StatusLifecycleDebugger {
  private isDebugging = false
  private logHistory: string[] = []

  /**
   * Start debug monitoring
   */
  startDebugging(): void {
    if (this.isDebugging) return
    
    console.log('🔍 Starting status lifecycle debugging')
    this.isDebugging = true
    this.logHistory = []
    
    // Monitor userDataService events
    userDataService.addEventListener('status-changed', (event: any) => {
      const log = `✅ Status changed: ${UserStatus[event.detail.status]} (User: ${event.detail.userId})`
      console.log(log)
      this.logHistory.push(`${new Date().toLocaleTimeString()} - ${log}`)
    })
    
    // Monitor activity tracker events
    activityTracker.addEventListener('activity-resumed', (event: any) => {
      const log = `👋 Activity resumed at ${new Date(event.detail.timestamp).toLocaleTimeString()}`
      console.log(log)
      this.logHistory.push(`${new Date().toLocaleTimeString()} - ${log}`)
    })
    
    activityTracker.addEventListener('status-should-change', (event: any) => {
      const log = `😴 Auto status change suggested: ${UserStatus[event.detail.status]} (${event.detail.reason})`
      console.log(log)
      this.logHistory.push(`${new Date().toLocaleTimeString()} - ${log}`)
    })
  }

  /**
   * Stop debug monitoring
   */
  stopDebugging(): void {
    console.log('⏹️ Stopping status lifecycle debugging')
    this.isDebugging = false
    
    if (this.statusChangedListener) {
      userDataService.removeEventListener('status-changed', this.statusChangedListener)
      this.statusChangedListener = undefined
    }
    
    if (this.activityResumedListener) {
      activityTracker.removeEventListener('activity-resumed', this.activityResumedListener)
      this.activityResumedListener = undefined
    }
    
    if (this.statusShouldChangeListener) {
      activityTracker.removeEventListener('status-should-change', this.statusShouldChangeListener)
      this.statusShouldChangeListener = undefined
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
    console.log(`🧪 Testing manual status change to: ${UserStatus[status]}`)
    try {
      await userDataService.updateCurrentUserStatus(status)
      console.log('✅ Manual status change successful')
    } catch (error) {
      console.error('❌ Manual status change failed:', error)
    }
  }

  /**
   * Simulate inactivity for testing
   */
  simulateInactivity(minutes: number): void {
    console.log(`🕐 Simulating ${minutes} minutes of inactivity...`)
    
    // Hack the activity tracker's last activity time
    const millisecondsAgo = minutes * 60 * 1000
    ;(activityTracker as any).lastActivity = Date.now() - millisecondsAgo
    
    console.log(`⏰ Last activity set to ${minutes} minutes ago`)
  }

  /**
   * Show debug panel in console
   */
  showDebugPanel(): void {
    const info = this.getCurrentStatusInfo()
    
    console.group('🔍 Status Lifecycle Debug Panel')
    console.log('Current User:', info.user)
    console.log('Activity State:', info.activity)
    console.log('Recent Log History:')
    info.logHistory.forEach((entry: string) => console.log('  ' + entry))
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
      console.log('Available statuses:', available)
      return `❌ Invalid status. Available: ${available.join(', ')}`
    }
  }
  ;(window as any).showStatusDebug = () => statusDebugger.showDebugPanel()
  ;(window as any).simulateInactivity = (minutes: number = 6) => {
    if (!minutes || isNaN(minutes)) {
      console.log('❌ Please provide a number of minutes. Example: simulateInactivity(6)')
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
    console.log('showStatusDebug() - Show current status and activity info')
    console.log('testStatus("Away") - Test manual status change')
    console.log('simulateInactivity(6) - Simulate 6 minutes of inactivity')
    console.log('resetActivity() - Reset activity tracker to now')
    console.log('Available statuses: Online, Away, Busy, Offline')
    console.groupEnd()
    return 'Help displayed above ☝️'
  }
}
