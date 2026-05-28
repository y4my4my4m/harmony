import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'

interface PersistedState {
  lastServerId: string | null
  lastChannelByServer: Record<string, string>
  categoryCollapseStates: Record<string, Record<string, boolean>>
  sidebarStates: {
    leftSidebarVisible: boolean
    rightSidebarVisible: boolean
  }
  appInitialized: boolean
  uiPreferences: {
    theme: string
    fontSize: number
    enableAnimations: boolean
  }
  lastActiveTimestamp: number
}

interface CategoryCollapseState {
  [categoryId: string]: boolean
}

interface ApplicationState {
  hasInitialized: boolean
  hasServers: boolean
  shouldShowSplash: boolean
  isRestoring: boolean
}

const STORAGE_KEY = 'app-state' // Will be prefixed with user ID by userStorage
const STATE_VERSION = '1.2.0'

const DEFAULT_STATE: PersistedState = {
  lastServerId: null,
  lastChannelByServer: {},
  categoryCollapseStates: {},
  sidebarStates: {
    leftSidebarVisible: false,
    rightSidebarVisible: false
  },
  appInitialized: false,
  uiPreferences: {
    theme: 'dark',
    fontSize: 14,
    enableAnimations: true
  },
  lastActiveTimestamp: Date.now()
}

const DEFAULT_APP_STATE: ApplicationState = {
  hasInitialized: false,
  hasServers: false,
  shouldShowSplash: false,
  isRestoring: false
}

class StatePersistenceService {
  private state: PersistedState = { ...DEFAULT_STATE }
  private appState: ApplicationState = { ...DEFAULT_APP_STATE }
  private isLoaded = false
  private loadingPromise: Promise<void> | null = null
  
  // PERFORMANCE FIX: Debounce localStorage writes to reduce overhead
  private saveTimeout: NodeJS.Timeout | null = null
  private pendingSave = false

  /**
   * Initialize and load persisted state with version migration
   */
  async initialize(): Promise<void> {
    if (this.loadingPromise) {
      return this.loadingPromise
    }

    this.loadingPromise = this._initialize()
    return this.loadingPromise
  }

  private async _initialize(): Promise<void> {
    try {
      const stored = userStorage.getItem(STORAGE_KEY)
      
      if (stored) {
        const parsed = JSON.parse(stored)
        
        // Migrate old state format if needed
        if (!parsed.lastActiveTimestamp) {
          parsed.lastActiveTimestamp = Date.now()
        }
        
        if (!parsed.uiPreferences) {
          parsed.uiPreferences = DEFAULT_STATE.uiPreferences
        }
        
        this.state = { ...DEFAULT_STATE, ...parsed }
        debug.log('✅ Loaded persisted state (v' + STATE_VERSION + '):', this.state)
      } else {
        debug.log('📱 No persisted state found, using defaults')
        this.state = { ...DEFAULT_STATE }
      }

      // Initialize app runtime state
      this.appState = {
        hasInitialized: this.state.appInitialized,
        hasServers: false, // Will be updated when servers are loaded
        shouldShowSplash: false, // Will be determined by initialization logic
        isRestoring: true
      }

      this.isLoaded = true
      await this.updateLastActiveTimestamp()
      
    } catch (error) {
      debug.warn('⚠️ Failed to load persisted state, using defaults:', error)
      this.state = { ...DEFAULT_STATE }
      this.appState = { ...DEFAULT_APP_STATE }
      this.isLoaded = true
    }
  }

  /**
   * Load persisted state from localStorage (synchronous fallback)
   */
  loadState(): PersistedState {
    if (!this.isLoaded) {
      debug.warn('⚠️ State not initialized, using defaults. Call initialize() first.')
      return { ...DEFAULT_STATE }
    }
    return this.state
  }

  /**
   * Update last active timestamp
   */
  private async updateLastActiveTimestamp(): Promise<void> {
    this.state.lastActiveTimestamp = Date.now()
    await this.saveState()
  }

  /**
   * Save current state to localStorage with error handling
   */
  private async saveState(): Promise<void> {
    try {
      const stateToSave = {
        ...this.state,
        lastActiveTimestamp: Date.now()
      }
      
      userStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave))
      debug.log('💾 State persisted to localStorage')
    } catch (error) {
      debug.warn('⚠️ Failed to persist state:', error)
      
      // Try to clear space and retry once
      try {
        this.clearOldStates()
        userStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
        debug.log('💾 State persisted after cleanup')
      } catch (retryError) {
        debug.error('❌ Failed to persist state even after cleanup:', retryError)
      }
    }
  }

  /**
   * ✅ PERFORMANCE FIX: Debounced save to reduce localStorage writes during initialization
   * Batches multiple rapid state changes into a single write
   */
  private debouncedSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
    }
    
    this.pendingSave = true
    this.saveTimeout = setTimeout(async () => {
      if (this.pendingSave) {
        await this.saveState()
        this.pendingSave = false
      }
    }, 500) // 500ms debounce for better batching during initialization
  }

  /**
   * ✅ PERFORMANCE FIX: Force immediate save for critical operations
   */
  async forceSave(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }
    this.pendingSave = false
    await this.saveState()
  }

  /**
   * ✅ PERFORMANCE FIX: Cleanup method for app shutdown/logout
   */
  async cleanup(): Promise<void> {
    // Force save any pending changes
    if (this.pendingSave) {
      await this.forceSave()
    }
    
    // Clear any pending timeouts
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }
  }

  /**
   * Clear old/unused localStorage keys to free up space
   */
  private clearOldStates(): void {
    const keysToRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key.startsWith('harmony-') || key.startsWith('category-')) && key !== STORAGE_KEY) {
        keysToRemove.push(key)
      }
    }
    
    keysToRemove.forEach(key => {
      localStorage.removeItem(key)
    })
    
    debug.log(`🧹 Cleaned up ${keysToRemove.length} old localStorage entries`)
  }

  /**
   * Set the last selected server with validation
   */
  async setLastServer(serverId: string | null): Promise<void> {
    if (!this.isLoaded) await this.initialize()
    
    this.state.lastServerId = serverId
    this.debouncedSave() // ✅ PERFORMANCE FIX: Use debounced save during initialization
    debug.log('📍 Last server saved:', serverId)
  }

  /**
   * Get the last selected server
   */
  getLastServer(): string | null {
    if (!this.isLoaded) {
      debug.warn('⚠️ State not loaded, returning null for last server')
      return null
    }
    return this.state.lastServerId
  }

  /**
   * Set the last selected channel for a specific server
   */
  async setLastChannel(serverId: string, channelId: string | null): Promise<void> {
    if (!this.isLoaded) await this.initialize()
    
    if (channelId) {
      this.state.lastChannelByServer[serverId] = channelId
    } else {
      delete this.state.lastChannelByServer[serverId]
    }
    
    this.debouncedSave() // ✅ PERFORMANCE FIX: Use debounced save during initialization
    debug.log('📍 Last channel saved for server', serverId, ':', channelId)
  }

  /**
   * Get the last selected channel for a specific server
   */
  getLastChannel(serverId: string): string | null {
    if (!this.isLoaded) {
      debug.warn('⚠️ State not loaded, returning null for last channel')
      return null
    }
    return this.state.lastChannelByServer[serverId] || null
  }

  /**
   * Set category collapse state for a specific server with batching
   */
  async setCategoryCollapseState(serverId: string, categoryId: string, collapsed: boolean): Promise<void> {
    if (!this.isLoaded) await this.initialize()
    
    if (!this.state.categoryCollapseStates[serverId]) {
      this.state.categoryCollapseStates[serverId] = {}
    }
    
    this.state.categoryCollapseStates[serverId][categoryId] = collapsed
    
    // Debounce saves for category states to avoid excessive writes
    this.debouncedSave()
    
    debug.log('📂 Category collapse state saved:', { serverId, categoryId, collapsed })
  }

  /**
   * Get category collapse state for a specific server and category
   */
  getCategoryCollapseState(serverId: string, categoryId: string): boolean {
    if (!this.isLoaded) {
      debug.warn('⚠️ State not loaded, returning default collapsed state')
      return false
    }
    
    const serverStates = this.state.categoryCollapseStates[serverId]
    return serverStates?.[categoryId] ?? false // Default to expanded (false)
  }

  /**
   * Get all category collapse states for a server
   */
  getServerCategoryStates(serverId: string): CategoryCollapseState {
    if (!this.isLoaded) {
      debug.warn('⚠️ State not loaded, returning empty category states')
      return {}
    }
    
    return this.state.categoryCollapseStates[serverId] || {}
  }

  /**
   * Batch update category collapse states for better performance
   */
  async batchUpdateCategoryStates(serverId: string, categoryStates: CategoryCollapseState): Promise<void> {
    if (!this.isLoaded) await this.initialize()
    
    this.state.categoryCollapseStates[serverId] = { ...categoryStates }
    await this.saveState()
    
    debug.log('📂 Batch updated category states for server:', serverId)
  }

  /**
   * Set sidebar visibility state
   */
  async setSidebarState(sidebar: 'left' | 'right', visible: boolean): Promise<void> {
    if (!this.isLoaded) await this.initialize()
    
    if (sidebar === 'left') {
      this.state.sidebarStates.leftSidebarVisible = visible
    } else {
      this.state.sidebarStates.rightSidebarVisible = visible
    }
    
    await this.saveState()
  }

  /**
   * Get sidebar visibility state
   */
  getSidebarState(sidebar: 'left' | 'right'): boolean {
    if (!this.isLoaded) {
      debug.warn('⚠️ State not loaded, returning default sidebar state')
      return false
    }
    
    const states = this.state.sidebarStates
    return sidebar === 'left' ? states.leftSidebarVisible : states.rightSidebarVisible
  }

  /**
   * Mark app as initialized to prevent splash screen flash
   */
  async setAppInitialized(initialized: boolean = true): Promise<void> {
    if (!this.isLoaded) await this.initialize()
    
    this.state.appInitialized = initialized
    this.appState.hasInitialized = initialized
    
    await this.saveState()
    debug.log('🚀 App initialization state saved:', initialized)
  }

  /**
   * Check if app has been initialized before (synchronous for early checks)
   */
  isAppInitialized(): boolean {
    // Try to get from runtime state first, then from persisted state
    if (this.isLoaded) {
      return this.state.appInitialized
    }
    
    // Fallback: quick localStorage check without full state loading
    try {
      const stored = userStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        return parsed.appInitialized === true
      }
    } catch (error) {
      debug.warn('⚠️ Failed to quick-check initialization state:', error)
    }
    
    return false
  }

  /**
   * Application runtime state management
   */
  setHasServers(hasServers: boolean): void {
    this.appState.hasServers = hasServers
    this.appState.shouldShowSplash = !hasServers && this.appState.hasInitialized
  }

  shouldShowNoServersSplash(): boolean {
    return this.appState.shouldShowSplash
  }

  isCurrentlyRestoring(): boolean {
    return this.appState.isRestoring
  }

  setRestorationComplete(): void {
    this.appState.isRestoring = false
  }

  /**
   * UI Preferences management
   */
  async setUIPreference<K extends keyof PersistedState['uiPreferences']>(
    key: K, 
    value: PersistedState['uiPreferences'][K]
  ): Promise<void> {
    if (!this.isLoaded) await this.initialize()
    
    this.state.uiPreferences[key] = value
    await this.saveState()
  }

  getUIPreference<K extends keyof PersistedState['uiPreferences']>(
    key: K
  ): PersistedState['uiPreferences'][K] {
    if (!this.isLoaded) {
      return DEFAULT_STATE.uiPreferences[key]
    }
    
    return this.state.uiPreferences[key]
  }

  /**
   * Clear all persisted state with confirmation
   */
  async clearState(): Promise<void> {
    this.state = { ...DEFAULT_STATE }
    this.appState = { ...DEFAULT_APP_STATE }
    this.isLoaded = false
    
    try {
      userStorage.removeItem(STORAGE_KEY)
      this.clearOldStates() // Also clean up any legacy keys
      debug.log('🗑️ All persisted state cleared')
    } catch (error) {
      debug.warn('⚠️ Failed to clear persisted state:', error)
    }
  }

  /**
   * Export current state for debugging/backup
   */
  exportState(): { persisted: PersistedState; runtime: ApplicationState } {
    return { 
      persisted: { ...this.state },
      runtime: { ...this.appState }
    }
  }

  /**
   * Import state from backup (with validation)
   */
  async importState(stateData: Partial<PersistedState>): Promise<boolean> {
    try {
      const validatedState = { ...DEFAULT_STATE, ...stateData }
      
      // Basic validation
      if (typeof validatedState.lastServerId !== 'string' && validatedState.lastServerId !== null) {
        throw new Error('Invalid lastServerId format')
      }
      
      this.state = validatedState
      await this.saveState()
      
      debug.log('📥 State imported successfully')
      return true
    } catch (error) {
      debug.error('❌ Failed to import state:', error)
      return false
    }
  }

  /**
   * Health check for state integrity
   */
  performHealthCheck(): { isHealthy: boolean; issues: string[] } {
    const issues: string[] = []
    
    try {
      // Check if localStorage is available
      localStorage.setItem('test', 'test')
      localStorage.removeItem('test')
    } catch (error) {
      issues.push('localStorage not available')
    }
    
    // Check state structure
    if (!this.isLoaded) {
      issues.push('State not loaded')
    }
    
    if (typeof this.state.lastServerId !== 'string' && this.state.lastServerId !== null) {
      issues.push('Invalid lastServerId type')
    }
    
    if (typeof this.state.lastChannelByServer !== 'object') {
      issues.push('Invalid lastChannelByServer type')
    }
    
    return {
      isHealthy: issues.length === 0,
      issues
    }
  }


}

// Create singleton instance
export const statePersistence = new StatePersistenceService()

// Initialize immediately for early access
statePersistence.initialize().catch(debug.error)
