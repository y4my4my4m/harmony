/**
 * Haptic Feedback Utility for Native App Feel
 * Provides tactile feedback on supported devices
 */

export type HapticPattern = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'selection' | 'impact' | 'notification'

export interface HapticOptions {
  pattern?: HapticPattern
  duration?: number
  intensity?: number
  enabled?: boolean
}

class HapticFeedbackManager {
  private isEnabled: boolean = true
  private isSupported: boolean = false

  constructor() {
    this.detectSupport()
    this.loadPreferences()
  }

  private detectSupport(): void {
    // Check for various haptic APIs
    this.isSupported = 
      'vibrate' in navigator || 
      'mozVibrate' in navigator || 
      'webkitVibrate' in navigator ||
      // @ts-ignore - checking for iOS haptic feedback
      (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function')
  }

  private loadPreferences(): void {
    // Note: This is a global setting, not user-specific
    // Haptic feedback preference doesn't need to be per-user
    try {
      const stored = localStorage.getItem('harmony-haptics-enabled')
      this.isEnabled = stored !== null ? stored === 'true' : true
    } catch {
      this.isEnabled = true
    }
  }

  private getPatternDuration(pattern: HapticPattern): number | number[] {
    const patterns = {
      light: 10,
      medium: 20,
      heavy: 50,
      success: [100, 50, 100],
      warning: [150, 100, 150],
      error: [200, 100, 200, 100, 200],
      selection: 5,
      impact: [30],
      notification: [100, 50, 100, 50, 100]
    }
    return patterns[pattern] || 20
  }

  /**
   * Trigger haptic feedback
   */
  trigger(options: HapticOptions = {}): void {
    if (!this.isEnabled || !this.isSupported) return

    const { pattern = 'light', duration } = options
    
    try {
      // Use modern Vibration API if available
      if ('vibrate' in navigator) {
        const vibrationPattern = duration || this.getPatternDuration(pattern)
        navigator.vibrate(vibrationPattern)
      }
      // Fallback for older browsers
      else if ('mozVibrate' in (navigator as any)) {
        const vibrationPattern = duration || this.getPatternDuration(pattern)
        ;(navigator as any).mozVibrate(vibrationPattern)
      }
      else if ('webkitVibrate' in (navigator as any)) {
        const vibrationPattern = duration || this.getPatternDuration(pattern)
        ;(navigator as any).webkitVibrate(vibrationPattern)
      }
    } catch {
      // Silently ignore - haptic feedback is non-critical
    }
  }

  /**
   * Quick trigger methods for common patterns
   */
  light(): void {
    this.trigger({ pattern: 'light' })
  }

  medium(): void {
    this.trigger({ pattern: 'medium' })
  }

  heavy(): void {
    this.trigger({ pattern: 'heavy' })
  }

  success(): void {
    this.trigger({ pattern: 'success' })
  }

  warning(): void {
    this.trigger({ pattern: 'warning' })
  }

  error(): void {
    this.trigger({ pattern: 'error' })
  }

  selection(): void {
    this.trigger({ pattern: 'selection' })
  }

  impact(): void {
    this.trigger({ pattern: 'impact' })
  }

  notification(): void {
    this.trigger({ pattern: 'notification' })
  }

  /**
   * Enable/disable haptic feedback
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled
    localStorage.setItem('harmony-haptics-enabled', enabled.toString())
  }

  /**
   * Check if haptic feedback is enabled and supported
   */
  get enabled(): boolean {
    return this.isEnabled && this.isSupported
  }

  get supported(): boolean {
    return this.isSupported
  }
}

export const hapticManager = new HapticFeedbackManager()

// Vue directive for haptic feedback
export const vHaptic = {
  mounted(el: HTMLElement, binding: any) {
    const { value = 'light', modifiers } = binding
    
    const eventType = modifiers.hover ? 'mouseenter' : 'click'
    
    const handleTrigger = () => {
      if (typeof value === 'string') {
        hapticManager.trigger({ pattern: value as HapticPattern })
      } else if (typeof value === 'object') {
        hapticManager.trigger(value)
      } else {
        hapticManager.light()
      }
    }

    el.addEventListener(eventType, handleTrigger)
    
    ;(el as any)._hapticCleanup = () => {
      el.removeEventListener(eventType, handleTrigger)
    }
  },
  
  unmounted(el: HTMLElement) {
    if ((el as any)._hapticCleanup) {
      ;(el as any)._hapticCleanup()
    }
  }
}
