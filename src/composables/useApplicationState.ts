import { ref, computed } from 'vue'
import { statePersistence } from '@/services/StatePersistence'
import { debug } from '@/utils/debug'

// Global application state for preventing splash flashes
const _isInitializing = ref(true)
const _hasInitialized = ref(false)
const _hasServers = ref(false)
const _initializationError = ref<string | null>(null)

/**
 * Composable for managing application initialization state
 * Prevents splash screen flashes and provides smooth loading experience
 */
export function useApplicationState() {
  
  /**
   * Check if the application should show loading state
   */
  const isInitializing = computed(() => _isInitializing.value)
  
  /**
   * Check if the application has completed initialization
   */
  const hasInitialized = computed(() => _hasInitialized.value)
  
  /**
   * Check if user has any servers
   */
  const hasServers = computed(() => _hasServers.value)
  
  /**
   * Get initialization error if any occurred
   */
  const initializationError = computed(() => _initializationError.value)
  
  /**
   * Determine if splash screen should be shown
   */
  const shouldShowSplash = computed(() => {
    return hasInitialized.value && !hasServers.value && !initializationError.value
  })
  
  /**
   * Determine if loading screen should be shown
   */
  const shouldShowLoading = computed(() => {
    return isInitializing.value && !initializationError.value
  })
  
  /**
   * Start application initialization
   */
  async function startInitialization(): Promise<void> {
    try {
      _isInitializing.value = true
      _initializationError.value = null
      
      // Initialize state persistence first
      await statePersistence.initialize()
      
      // Check if app was previously initialized to prevent flash
      const wasInitialized = statePersistence.isAppInitialized()
      if (wasInitialized) {
        // For returning users, show minimal loading time
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      
      debug.log('🚀 Application state initialization started')
      
    } catch (error) {
      debug.error('❌ Failed to initialize application state:', error)
      _initializationError.value = error instanceof Error ? error.message : 'Unknown error'
    }
  }
  
  /**
   * Complete initialization process
   */
  async function completeInitialization(serverCount: number): Promise<void> {
    try {
      _hasServers.value = serverCount > 0
      _hasInitialized.value = true
      _isInitializing.value = false
      
      statePersistence.setHasServers(serverCount > 0)
      await statePersistence.setAppInitialized(true)
      
      debug.log('✅ Application initialization completed', {
        hasServers: _hasServers.value,
        serverCount
      })
      
    } catch (error) {
      debug.error('❌ Failed to complete initialization:', error)
      _initializationError.value = error instanceof Error ? error.message : 'Initialization completion failed'
    }
  }
  
  /**
   * Update server count (when user joins/leaves servers)
   */
  function updateServerCount(count: number): void {
    const hadServers = _hasServers.value
    _hasServers.value = count > 0
    
    if (hadServers !== _hasServers.value) {
      statePersistence.setHasServers(_hasServers.value)
      debug.log('📊 Server count updated:', { count, hasServers: _hasServers.value })
    }
  }
  
  /**
   * Set initialization error
   */
  function setInitializationError(error: string | null): void {
    _initializationError.value = error
    if (error) {
      _isInitializing.value = false
      debug.error('❌ Initialization error set:', error)
    }
  }
  
  /**
   * Reset application state (for logout, etc.)
   */
  async function resetApplicationState(): Promise<void> {
    _isInitializing.value = true
    _hasInitialized.value = false
    _hasServers.value = false
    _initializationError.value = null
    
    debug.log('🔄 Application state reset')
  }
  
  /**
   * Get early state for preventing flash (synchronous)
   */
  function getEarlyState() {
    return {
      shouldShowSplash: !statePersistence.isAppInitialized(),
      isFirstTime: !statePersistence.isAppInitialized()
    }
  }
  
  return {
    // Computed state
    isInitializing,
    hasInitialized,
    hasServers,
    initializationError,
    shouldShowSplash,
    shouldShowLoading,
    
    // Actions
    startInitialization,
    completeInitialization,
    updateServerCount,
    setInitializationError,
    resetApplicationState,
    getEarlyState
  }
}

// Export a singleton instance for global state management
export const applicationState = useApplicationState()
