/**
 * Unified Application Service
 * 
 * This service provides shared functionality and state management
 * between chat and ActivityPub systems, ensuring consistency
 * and reducing code duplication.
 */

import { ref, reactive, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useActivityPubStore } from '@/stores/activitypub'
import { useDMStore } from '@/stores/useDM'

export type AppMode = 'chat' | 'activitypub'
export type ChatMode = 'server' | 'dm'
export type ActivityPubTimeline = 'home' | 'local' | 'public'

export interface AppState {
  // Core application state
  currentMode: AppMode
  isInitialized: boolean
  isLoading: boolean
  
  // Chat specific state
  chatMode: ChatMode
  currentServerId: string | null
  currentChannelId: string | null
  currentConversationId: string | null
  
  // ActivityPub specific state
  currentTimeline: ActivityPubTimeline
  
  // UI state
  sidebarVisible: boolean
  profilesPanelVisible: boolean
  isMobile: boolean
  
  // Modal state
  activeModals: Set<string>
  
  // Error handling
  lastError: string | null
  isOffline: boolean
}

class UnifiedAppService {
  private static instance: UnifiedAppService
  
  // Reactive state
  public state = reactive<AppState>({
    currentMode: 'chat',
    isInitialized: false,
    isLoading: false,
    
    chatMode: 'server',
    currentServerId: null,
    currentChannelId: null,
    currentConversationId: null,
    
    currentTimeline: 'home',
    
    sidebarVisible: false,
    profilesPanelVisible: false,
    isMobile: false,
    
    activeModals: new Set(),
    
    lastError: null,
    isOffline: false
  })
  
  // Event listeners for system events
  private eventListeners = new Map<string, Function[]>()
  
  // Store event handler references for proper cleanup
  private onlineHandler = () => {
    this.state.isOffline = false
    this.emit('network:online')
  }
  
  private offlineHandler = () => {
    this.state.isOffline = true
    this.emit('network:offline')
  }
  
  private resizeHandler = () => {
    this.state.isMobile = window.innerWidth < 768
  }
  
  private constructor() {
    this.setupNetworkListeners()
    this.setupMobileDetection()
  }
  
  static getInstance(): UnifiedAppService {
    if (!UnifiedAppService.instance) {
      UnifiedAppService.instance = new UnifiedAppService()
    }
    return UnifiedAppService.instance
  }
  
  // ===== INITIALIZATION =====
  
  async initialize(): Promise<void> {
    console.log('🚀 Initializing Unified App Service')
    
    try {
      this.state.isLoading = true
      
      // Initialize stores in the correct order
      const authStore = useAuthStore()
      
      // Wait for auth to be ready
      if (!authStore.session) {
        console.log('⏳ Waiting for authentication...')
        return
      }
      
      // Initialize both chat and ActivityPub systems
      await Promise.all([
        this.initializeChatSystem(),
        this.initializeActivityPubSystem()
      ])
      
      this.state.isInitialized = true
      this.emit('app:initialized')
      
      console.log('✅ Unified App Service initialized')
      
    } catch (error) {
      console.error('❌ Failed to initialize app service:', error)
      this.setError('Failed to initialize application')
    } finally {
      this.state.isLoading = false
    }
  }
  
  private async initializeChatSystem(): Promise<void> {
    const serverChannelStore = useServerChannelStore()
    const dmStore = useDMStore()
    const authStore = useAuthStore()
    
    try {
      // Load servers and basic chat data
      await serverChannelStore.fetchServers()
      
      // Initialize DM conversations with current user ID
      if (authStore.session?.user?.id) {
        await dmStore.fetchUserConversations(authStore.session.user.id)
      }
      
      this.emit('chat:initialized')
    } catch (error) {
      console.error('Failed to initialize chat system:', error)
      throw error
    }
  }
  
  private async initializeActivityPubSystem(): Promise<void> {
    const activityPubStore = useActivityPubStore()
    
    try {
      // Initialize ActivityPub federation
      await activityPubStore.initialize()
      
      this.emit('activitypub:initialized')
    } catch (error) {
      console.error('Failed to initialize ActivityPub system:', error)
      throw error
    }
  }
  
  // ===== MODE MANAGEMENT =====
  
  setMode(mode: AppMode): void {
    if (this.state.currentMode === mode) return
    
    const previous = this.state.currentMode
    console.log(`🔄 Switching from ${previous} to ${mode}`)
    
    this.state.currentMode = mode
    this.emit('mode:changed', { from: previous, to: mode })
  }
  
  setChatMode(mode: ChatMode): void {
    if (this.state.chatMode === mode) return
    
    this.state.chatMode = mode
    this.emit('chat:mode:changed', mode)
  }
  
  setTimeline(timeline: ActivityPubTimeline): void {
    if (this.state.currentTimeline === timeline) return
    
    this.state.currentTimeline = timeline
    this.emit('activitypub:timeline:changed', timeline)
  }
  
  // ===== NAVIGATION =====
  
  async navigateToServer(serverId: string, channelId?: string): Promise<void> {
    this.setMode('chat')
    this.setChatMode('server')
    
    this.state.currentServerId = serverId
    this.state.currentChannelId = channelId || null
    this.state.currentConversationId = null
    
    this.emit('navigation:server', { serverId, channelId })
  }
  
  async navigateToDM(conversationId: string): Promise<void> {
    this.setMode('chat')
    this.setChatMode('dm')
    
    this.state.currentConversationId = conversationId
    this.state.currentServerId = null
    this.state.currentChannelId = null
    
    this.emit('navigation:dm', { conversationId })
  }
  
  async navigateToActivityPub(timeline: ActivityPubTimeline = 'home'): Promise<void> {
    this.setMode('activitypub')
    this.setTimeline(timeline)
    
    // Clear chat context
    this.state.currentServerId = null
    this.state.currentChannelId = null
    this.state.currentConversationId = null
    
    this.emit('navigation:activitypub', { timeline })
  }
  
  // ===== UI STATE MANAGEMENT =====
  
  toggleSidebar(): void {
    this.state.sidebarVisible = !this.state.sidebarVisible
    this.emit('ui:sidebar:toggled', this.state.sidebarVisible)
  }
  
  toggleProfilesPanel(): void {
    this.state.profilesPanelVisible = !this.state.profilesPanelVisible
    this.emit('ui:profiles:toggled', this.state.profilesPanelVisible)
  }
  
  setSidebarVisible(visible: boolean): void {
    this.state.sidebarVisible = visible
    this.emit('ui:sidebar:changed', visible)
  }
  
  setProfilesPanelVisible(visible: boolean): void {
    this.state.profilesPanelVisible = visible
    this.emit('ui:profiles:changed', visible)
  }
  
  // ===== MODAL MANAGEMENT =====
  
  openModal(modalId: string): void {
    this.state.activeModals.add(modalId)
    this.emit('modal:opened', modalId)
  }
  
  closeModal(modalId: string): void {
    this.state.activeModals.delete(modalId)
    this.emit('modal:closed', modalId)
  }
  
  closeAllModals(): void {
    const modalIds = Array.from(this.state.activeModals)
    this.state.activeModals.clear()
    modalIds.forEach(id => this.emit('modal:closed', id))
    this.emit('modals:all:closed')
  }
  
  isModalOpen(modalId: string): boolean {
    return this.state.activeModals.has(modalId)
  }
  
  // ===== ERROR HANDLING =====
  
  setError(error: string | null): void {
    this.state.lastError = error
    if (error) {
      this.emit('error:occurred', error)
    }
  }
  
  clearError(): void {
    this.state.lastError = null
    this.emit('error:cleared')
  }
  
  // ===== NETWORK STATE =====
  
  private setupNetworkListeners(): void {
    window.addEventListener('online', this.onlineHandler)
    window.addEventListener('offline', this.offlineHandler)
    this.state.isOffline = !navigator.onLine
  }
  
  // ===== MOBILE DETECTION =====
  
  private setupMobileDetection(): void {
    // Set initial mobile state
    this.state.isMobile = window.innerWidth < 768
    window.addEventListener('resize', this.resizeHandler)
  }
  
  // ===== EVENT SYSTEM =====
  
  on(event: string, callback: Function): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, [])
    }
    this.eventListeners.get(event)!.push(callback)
  }
  
  off(event: string, callback: Function): void {
    const listeners = this.eventListeners.get(event)
    if (listeners) {
      const index = listeners.indexOf(callback)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    }
  }
  
  emit(event: string, data?: any): void {
    const listeners = this.eventListeners.get(event) || []
    listeners.forEach(callback => {
      try {
        callback(data)
      } catch (error) {
        console.error(`Error in event listener for ${event}:`, error)
      }
    })
  }
  
  // ===== COMPUTED PROPERTIES =====
  
  get isInChatMode(): boolean {
    return this.state.currentMode === 'chat'
  }
  
  get isInActivityPubMode(): boolean {
    return this.state.currentMode === 'activitypub'
  }
  
  get isInServerMode(): boolean {
    return this.isInChatMode && this.state.chatMode === 'server'
  }
  
  get isInDMMode(): boolean {
    return this.isInChatMode && this.state.chatMode === 'dm'
  }
  
  get hasActiveContext(): boolean {
    return !!(
      this.state.currentServerId ||
      this.state.currentConversationId ||
      this.isInActivityPubMode
    )
  }
  
  get currentContextInfo(): any {
    if (this.isInServerMode && this.state.currentServerId) {
      return {
        type: 'server',
        serverId: this.state.currentServerId,
        channelId: this.state.currentChannelId
      }
    }
    
    if (this.isInDMMode && this.state.currentConversationId) {
      return {
        type: 'dm',
        conversationId: this.state.currentConversationId
      }
    }
    
    if (this.isInActivityPubMode) {
      return {
        type: 'activitypub',
        timeline: this.state.currentTimeline
      }
    }
    
    return null
  }
  
  // ===== CLEANUP =====
  
  destroy(): void {
    this.eventListeners.clear()
    window.removeEventListener('online', this.onlineHandler)
    window.removeEventListener('offline', this.offlineHandler)
    window.removeEventListener('resize', this.resizeHandler)
  }
}

// Export singleton instance and utilities
export const unifiedAppService = UnifiedAppService.getInstance()

// Composable for using the service in components
export function useUnifiedApp() {
  return {
    state: unifiedAppService.state,
    
    // Mode management
    setMode: unifiedAppService.setMode.bind(unifiedAppService),
    setChatMode: unifiedAppService.setChatMode.bind(unifiedAppService),
    setTimeline: unifiedAppService.setTimeline.bind(unifiedAppService),
    
    // Navigation
    navigateToServer: unifiedAppService.navigateToServer.bind(unifiedAppService),
    navigateToDM: unifiedAppService.navigateToDM.bind(unifiedAppService),
    navigateToActivityPub: unifiedAppService.navigateToActivityPub.bind(unifiedAppService),
    
    // UI state
    toggleSidebar: unifiedAppService.toggleSidebar.bind(unifiedAppService),
    toggleProfilesPanel: unifiedAppService.toggleProfilesPanel.bind(unifiedAppService),
    setSidebarVisible: unifiedAppService.setSidebarVisible.bind(unifiedAppService),
    setProfilesPanelVisible: unifiedAppService.setProfilesPanelVisible.bind(unifiedAppService),
    
    // Modal management
    openModal: unifiedAppService.openModal.bind(unifiedAppService),
    closeModal: unifiedAppService.closeModal.bind(unifiedAppService),
    closeAllModals: unifiedAppService.closeAllModals.bind(unifiedAppService),
    isModalOpen: unifiedAppService.isModalOpen.bind(unifiedAppService),
    
    // Error handling
    setError: unifiedAppService.setError.bind(unifiedAppService),
    clearError: unifiedAppService.clearError.bind(unifiedAppService),
    
    // Event system
    on: unifiedAppService.on.bind(unifiedAppService),
    off: unifiedAppService.off.bind(unifiedAppService),
    emit: unifiedAppService.emit.bind(unifiedAppService),
    
    // Computed properties
    isInChatMode: computed(() => unifiedAppService.isInChatMode),
    isInActivityPubMode: computed(() => unifiedAppService.isInActivityPubMode),
    isInServerMode: computed(() => unifiedAppService.isInServerMode),
    isInDMMode: computed(() => unifiedAppService.isInDMMode),
    hasActiveContext: computed(() => unifiedAppService.hasActiveContext),
    currentContextInfo: computed(() => unifiedAppService.currentContextInfo)
  }
}

// Auto-initialize when auth is ready
export function initializeApp() {
  const authStore = useAuthStore()
  
  // Watch for auth changes and initialize when ready
  authStore.$subscribe((mutation, state) => {
    if (state.session && !unifiedAppService.state.isInitialized) {
      unifiedAppService.initialize()
    }
  })
  
  // Initialize immediately if already authenticated
  if (authStore.session && !unifiedAppService.state.isInitialized) {
    unifiedAppService.initialize()
  }
}