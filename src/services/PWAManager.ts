/**
 * Enhanced PWA Manager
 * Handles native app-like behaviors and PWA features
 */

import { debug } from '@/utils/debug'
import { hapticManager } from '@/utils/hapticFeedback'
import {
  isPWA as checkIsPWA,
  isMobileUserAgent,
  logInstallDiagnostics,
  shouldDeferInstallPrompt,
} from '@/utils/pwaUtils'
import { shouldAllowNativeContextMenu } from '@/utils/nativeContextMenu'

export interface PWAInstallPrompt {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export interface PWACapabilities {
  canInstall: boolean
  isInstalled: boolean
  isStandalone: boolean
  supportsNotifications: boolean
  supportsBackgroundSync: boolean
  supportsShare: boolean
  supportsBadging: boolean
  supportsShortcuts: boolean
}

export class PWAManager {
  private static instance: PWAManager
  private installPrompt: PWAInstallPrompt | null = null
  /** Set when beforeinstallprompt fires; cleared on appinstalled */
  private installOffered = false
  private capabilities: PWACapabilities = {
    canInstall: false,
    isInstalled: false,
    isStandalone: false,
    supportsNotifications: false,
    supportsBackgroundSync: false,
    supportsShare: false,
    supportsBadging: false,
    supportsShortcuts: false
  }

  public static getInstance(): PWAManager {
    if (!PWAManager.instance) {
      PWAManager.instance = new PWAManager()
    }
    return PWAManager.instance
  }

  /**
   * Initialize PWA features
   */
  async initialize(): Promise<void> {
    debug.log('🚀 PWA Manager: Initializing...')

    // Detect PWA capabilities
    this.detectCapabilities()

    this.setupInstallPrompt()

    this.setupNativeAppBehaviors()

    this.setupShareTarget()

    this.setupAppShortcuts()

    this.setupBadgeAPI()

    // Refresh flags after listeners are registered (installPrompt may still be null until event fires)
    this.detectCapabilities()

    void logInstallDiagnostics({ canInstallDeferred: this.installPrompt !== null })

    debug.log('✅ PWA Manager: Initialized with capabilities:', this.capabilities)
  }

  /**
   * Detect PWA capabilities
   */
  private detectCapabilities(): void {
    this.capabilities = {
      canInstall: this.installOffered && !this.isAppInstalled(),
      isInstalled: this.isAppInstalled(),
      isStandalone: this.isStandaloneMode(),
      supportsNotifications: 'Notification' in window,
      supportsBackgroundSync: 'serviceWorker' in navigator && 'sync' in window.ServiceWorkerRegistration.prototype,
      supportsShare: 'share' in navigator,
      supportsBadging: 'setAppBadge' in navigator,
      supportsShortcuts: 'getInstalledRelatedApps' in navigator
    }
  }

  /**
   * Setup install prompt handling
   */
  private setupInstallPrompt(): void {
    window.addEventListener('beforeinstallprompt', (event) => {
      debug.log('💾 PWA Manager: Install prompt available', {
        deferForCustomUi: shouldDeferInstallPrompt(),
      })

      // `BeforeInstallPromptEvent` is not in lib.dom; treat as `any`.
      const installEvent = event as any

      // Desktop: do not preventDefault - Chrome omnibox install uses native UI.
      // Mobile: defer so we can show the in-app install banner at the right time.
      this.installOffered = true

      if (shouldDeferInstallPrompt()) {
        installEvent.preventDefault()
        this.installPrompt = installEvent
      } else {
        this.installPrompt = null
      }

      this.detectCapabilities()
      this.notifyInstallAvailable()
    })

    window.addEventListener('appinstalled', () => {
      debug.log('✅ PWA Manager: App installed successfully')
      this.installPrompt = null
      this.installOffered = false
      this.detectCapabilities()
      this.notifyAppInstalled()
    })
  }

  /**
   * Enhanced setup for native app behaviors
   */
  private setupNativeAppBehaviors(): void {
    // Prevent context menus on touch devices for app-like feel, but never
    // block the OS/browser menu when the user has selected text or is
    // interacting with links/media inside message/post content.
    if (checkIsPWA() || isMobileUserAgent()) {
      document.addEventListener('contextmenu', (e) => {
        if (shouldAllowNativeContextMenu(e)) return
        e.preventDefault()
      })
    }

    // Enhanced pull-to-refresh
    if (checkIsPWA()) {
      this.setupPullToRefresh()
    }

    this.setupSafeAreas()

    // Prevent zoom on double tap
    this.preventDoubleClickZoom()

    this.setupFocusManagement()

    this.setupKeyboardShortcuts()

    this.setupNativeScrolling()

    this.setupOrientationHandling()
  }

  /**
   * Escape blurs the focused element for native-like keyboard dismissal
   */
  private setupFocusManagement(): void {
    let lastFocusedElement: HTMLElement | null = null

    document.addEventListener('focusin', (e) => {
      lastFocusedElement = e.target as HTMLElement
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lastFocusedElement) {
        lastFocusedElement.blur()
      }
    })
  }

  /**
   * Setup keyboard shortcuts for common PWA actions
   */
  private setupKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      // Cmd/Ctrl + R for refresh
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault()
        window.location.reload()
        return
      }

      // Cmd/Ctrl + Shift + R for hard refresh
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'R') {
        e.preventDefault()
        if ('caches' in window) {
          caches.keys().then(names => {
            names.forEach(name => caches.delete(name))
          }).then(() => {
            window.location.reload()
          })
        }
        return
      }

      // F11 for fullscreen (if supported)
      if (e.key === 'F11' && 'requestFullscreen' in document.documentElement) {
        e.preventDefault()
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen()
        } else {
          document.exitFullscreen()
        }
      }
    })
  }

  /**
   * Setup native-like scrolling behavior
   */
  private setupNativeScrolling(): void {
    // Smooth scroll for better UX
    document.documentElement.style.scrollBehavior = 'smooth'

    // Add momentum scrolling for iOS. `webkitOverflowScrolling` is a vendor
    // CSS property not present on `CSSStyleDeclaration` in lib.dom.
    ;(document.body.style as any).webkitOverflowScrolling = 'touch'

    // Prevent overscroll on body
    document.body.style.overscrollBehavior = 'none'
  }

  /**
   * Setup orientation change handling
   */
  private setupOrientationHandling(): void {
    const handleOrientationChange = () => {
      window.dispatchEvent(new CustomEvent('pwa-orientation-change', {
        detail: {
          orientation: screen.orientation?.type || 'unknown',
          angle: screen.orientation?.angle || 0
        }
      }))

      const vh = window.innerHeight * 0.01
      document.documentElement.style.setProperty('--vh', `${vh}px`)
    }

    // Listen for orientation changes
    if (screen.orientation) {
      screen.orientation.addEventListener('change', handleOrientationChange)
    } else {
      // Fallback for older browsers
      window.addEventListener('orientationchange', handleOrientationChange)
    }

    // Initial setup
    handleOrientationChange()
  }

  /**
   * Setup share target handling
   */
  private setupShareTarget(): void {
    const urlParams = new URLSearchParams(window.location.search)
    
    if (urlParams.has('title') || urlParams.has('text') || urlParams.has('url')) {
      const sharedData = {
        title: urlParams.get('title') || '',
        text: urlParams.get('text') || '',
        url: urlParams.get('url') || ''
      }
      
      debug.log('📤 PWA Manager: Handling shared content:', sharedData)
      this.handleSharedContent(sharedData)
    }
  }

  /**
   * Setup app shortcuts handling
   */
  private setupAppShortcuts(): void {
    const path = window.location.pathname
    
    if (path === '/dm') {
      debug.log('📱 PWA Manager: Launched via DM shortcut')
      // Navigate to DMs or handle DM shortcut
    } else if (path === '/notifications') {
      debug.log('🔔 PWA Manager: Launched via notifications shortcut')
      // Navigate to notifications or handle notification shortcut
    }
  }

  /**
   * Setup badge API for notification count
   */
  private setupBadgeAPI(): void {
    if (this.capabilities.supportsBadging) {
      debug.log('🏷️ PWA Manager: Badge API supported')
    }
  }

  /**
   * Update app badge with notification count
   */
  async updateBadge(count: number): Promise<void> {
    if (!this.capabilities.supportsBadging) return

    try {
      if (count > 0) {
        await (navigator as any).setAppBadge(count)
      } else {
        await (navigator as any).clearAppBadge()
      }
    } catch (error) {
      debug.warn('⚠️ PWA Manager: Failed to update badge:', error)
    }
  }

  /**
   * Show install prompt
   */
  async showInstallPrompt(): Promise<boolean> {
    if (!this.installPrompt) {
      debug.warn(
        '⚠️ PWA Manager: No deferred install prompt (use browser address-bar install on desktop)'
      )
      return false
    }

    try {
      await this.installPrompt.prompt()
      const result = await this.installPrompt.userChoice

      debug.log('💾 PWA Manager: Install prompt result:', result.outcome)

      // Prompt can only be used once per beforeinstallprompt event
      this.installPrompt = null

      if (result.outcome === 'accepted') {
        this.capabilities.canInstall = false
        this.detectCapabilities()
        return true
      }

      this.detectCapabilities()
      return false
    } catch (error) {
      debug.error('❌ PWA Manager: Install prompt failed:', error)
      this.installPrompt = null
      this.detectCapabilities()
      return false
    }
  }

  /**
   * Whether the in-app Install button can call prompt() (mobile deferred flow).
   */
  hasDeferredInstallPrompt(): boolean {
    return this.installPrompt !== null
  }

  /**
   * Share content using Web Share API
   */
  async shareContent(data: ShareData): Promise<boolean> {
    if (!this.capabilities.supportsShare) {
      debug.warn('⚠️ PWA Manager: Web Share API not supported')
      return false
    }

    try {
      await navigator.share(data)
      debug.log('📤 PWA Manager: Content shared successfully')
      return true
    } catch (error) {
      debug.warn('⚠️ PWA Manager: Share failed:', error)
      return false
    }
  }

  /**
   * Enhanced pull-to-refresh with better UX - only for timeline/chat contexts
   */
  private setupPullToRefresh(): void {
    let startY = 0
    let currentY = 0
    let pullDistance = 0
    const pullThreshold = 80
    const maxPull = 120
    let isPulling = false
    let hasHapticTriggered = false  // Track if we've triggered haptic for crossing threshold
    let refreshIndicator: HTMLElement | null = null
    let validScrollContainer: Element | null = null

    const validSelectors = [
      '[data-timeline]',           // Timeline feeds
      '[data-chat-messages]',      // Chat/DM messages
      '.timeline-container',       // Timeline container
      '.messages-container',       // Messages container
      '.feed-container',          // Feed container
      '#timeline',                // Timeline by ID
      '#messages'                 // Messages by ID
    ]

    const isValidPullToRefreshContext = (target: Element): boolean => {
      for (const selector of validSelectors) {
        if (target.matches?.(selector) || target.closest?.(selector)) {
          return true
        }
      }
      return false
    }

    const isAtTopOfScrollContainer = (container: Element): boolean => {
      return container.scrollTop <= 0
    }

    const findScrollContainer = (target: Element): Element | null => {
      let current: Element | null = target
      
      while (current && current !== document.documentElement) {
        const computedStyle = window.getComputedStyle(current)
        const overflowY = computedStyle.overflowY
        
        if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
          return current
        }
        
        current = current.parentElement
      }
      
      // Fallback to window/document
      return null
    }

    const createRefreshIndicator = () => {
      if (refreshIndicator) return refreshIndicator

      refreshIndicator = document.createElement('div')
      refreshIndicator.className = 'pwa-refresh-indicator'
      refreshIndicator.innerHTML = `
        <div class="refresh-content">
          <div class="refresh-icon">
            <svg viewBox="0 0 24 24" width="24" height="24">
              <path fill="currentColor" d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z"/>
            </svg>
          </div>
          <div class="refresh-text">Pull to refresh</div>
        </div>
      `
      
      Object.assign(refreshIndicator.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        height: '80px',
        background: 'linear-gradient(to bottom, #0EA5E9, transparent)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        transform: 'translateY(-100%)',
        transition: 'transform 0.3s ease',
        zIndex: '1000',
        pointerEvents: 'none'
      })

      document.body.appendChild(refreshIndicator)
      return refreshIndicator
    }

    const updateRefreshIndicator = (progress: number) => {
      const indicator = createRefreshIndicator()
      const normalizedProgress = Math.min(progress / pullThreshold, 1)
      
      indicator.style.transform = `translateY(${-100 + (normalizedProgress * 100)}%)`
      
      const icon = indicator.querySelector('.refresh-icon') as HTMLElement
      if (icon) {
        icon.style.transform = `rotate(${normalizedProgress * 360}deg)`
      }

      const text = indicator.querySelector('.refresh-text') as HTMLElement
      if (text) {
        const crossedThreshold = progress >= pullThreshold
        text.textContent = crossedThreshold ? 'Release to refresh' : 'Pull to refresh'
        
        // Haptic feedback when first crossing threshold
        if (crossedThreshold && !hasHapticTriggered) {
          hapticManager.trigger({ pattern: 'selection' })
          hasHapticTriggered = true
        } else if (!crossedThreshold) {
          hasHapticTriggered = false
        }
      }
    }

    const hideRefreshIndicator = () => {
      if (refreshIndicator) {
        refreshIndicator.style.transform = 'translateY(-100%)'
        setTimeout(() => {
          if (refreshIndicator && refreshIndicator.parentNode) {
            refreshIndicator.parentNode.removeChild(refreshIndicator)
            refreshIndicator = null
          }
        }, 300)
      }
    }

    document.addEventListener('touchstart', (e) => {
      const target = e.target as Element
      
      // Only start pulling if:
      // 1. We're in a valid context (timeline/chat)
      // 2. The page/container is at the very top
      if (!isValidPullToRefreshContext(target)) {
        return
      }

      validScrollContainer = findScrollContainer(target)
      
      const isAtTop = validScrollContainer 
        ? isAtTopOfScrollContainer(validScrollContainer)
        : window.scrollY === 0

      if (isAtTop) {
        startY = e.touches[0].clientY
        isPulling = true
        hasHapticTriggered = false  // Reset haptic trigger state for new pull
      }
    }, { passive: true })

    document.addEventListener('touchmove', (e) => {
      if (!isPulling) return

      // Double-check we're still at the top during the move
      const isAtTop = validScrollContainer 
        ? isAtTopOfScrollContainer(validScrollContainer)
        : window.scrollY === 0

      if (!isAtTop) {
        isPulling = false
        hideRefreshIndicator()
        return
      }

      currentY = e.touches[0].clientY
      pullDistance = Math.max(0, Math.min(maxPull, currentY - startY))

      if (pullDistance > 0) {
        updateRefreshIndicator(pullDistance)
      }
    }, { passive: true })

    document.addEventListener('touchend', () => {
      if (!isPulling) return

      if (pullDistance >= pullThreshold) {
        // Haptic feedback when releasing pull-to-refresh
        hapticManager.trigger({ pattern: 'light' })
        this.triggerRefresh()
      }

      hideRefreshIndicator()
      isPulling = false
      startY = 0
      currentY = 0
      pullDistance = 0
      validScrollContainer = null
    })
  }

  /**
   * Setup safe areas for notch devices
   */
  private setupSafeAreas(): void {
    document.documentElement.style.setProperty('--safe-area-inset-top', 'env(safe-area-inset-top)')
    document.documentElement.style.setProperty('--safe-area-inset-right', 'env(safe-area-inset-right)')
    document.documentElement.style.setProperty('--safe-area-inset-bottom', 'env(safe-area-inset-bottom)')
    document.documentElement.style.setProperty('--safe-area-inset-left', 'env(safe-area-inset-left)')
  }

  /**
   * Prevent double-click zoom on iOS
   */
  private preventDoubleClickZoom(): void {
    let lastTouchEnd = 0
    
    document.addEventListener('touchend', (event) => {
      const now = Date.now()
      if (now - lastTouchEnd <= 300) {
        event.preventDefault()
      }
      lastTouchEnd = now
    }, false)
  }

  /**
   * Utility methods
   */
  private isAppInstalled(): boolean {
    return checkIsPWA()
  }

  private isStandaloneMode(): boolean {
    return checkIsPWA()
  }

  private notifyInstallAvailable(): void {
    window.dispatchEvent(new CustomEvent('pwa-install-available'))
  }

  private notifyAppInstalled(): void {
    window.dispatchEvent(new CustomEvent('pwa-app-installed'))
  }

  private handleSharedContent(data: any): void {
    window.dispatchEvent(new CustomEvent('pwa-shared-content', { detail: data }))
  }

  private showPullToRefreshIndicator(): void {
    // Implement pull-to-refresh UI
    debug.log('📱 PWA Manager: Show pull-to-refresh indicator')
  }

  private hidePullToRefreshIndicator(): void {
    debug.log('📱 PWA Manager: Hide pull-to-refresh indicator')
  }

  /**
   * Trigger a hard refresh
   */
  private triggerRefresh(): void {
    debug.log('🔄 PWA Manager: Triggering refresh')
    window.location.reload()
  }

  /**
   * Get current capabilities
   */
  getCapabilities(): PWACapabilities {
    return { ...this.capabilities }
  }

  /**
   * Check if feature is supported
   */
  isSupported(feature: keyof PWACapabilities): boolean {
    return this.capabilities[feature]
  }
}

// Export singleton instance
export const pwaManager = PWAManager.getInstance()
