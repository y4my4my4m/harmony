/**
 * Global DM Call Listener
 * Subscribes to call signals for ALL user's DM conversations
 * Ensures incoming calls are received even when not viewing that DM
 */

import { ref } from 'vue'
import { dmCallSignaling, type CallSignal } from './DMCallSignaling'
import { dmCallPermissions } from './DMCallPermissions'
import { useToast } from 'vue-toastification'

export interface IncomingCallData {
  callerId: string
  callerName: string
  callerAvatar: string
  callType: 'voice' | 'video'
  conversationId: string
  timestamp: number
}

class GlobalDMCallListenerService {
  private unsubscribers: Map<string, () => void> = new Map()
  private currentUserId: string | null = null
  
  // Reactive state for incoming calls
  public incomingCall = ref<IncomingCallData | null>(null)
  public showIncomingCallModal = ref(false)
  
  // Callbacks
  private onIncomingCallCallback: ((call: IncomingCallData) => void) | null = null

  /**
   * Initialize global call listening for all user's conversations
   */
  async initialize(userId: string, conversationIds: string[]): Promise<void> {
    this.currentUserId = userId
    console.log(`📞 Initializing global call listener for ${conversationIds.length} conversations`)
    
    // Subscribe to all conversations
    for (const conversationId of conversationIds) {
      this.subscribeToConversation(conversationId)
    }
  }

  /**
   * Subscribe to a single conversation
   */
  private subscribeToConversation(conversationId: string): void {
    // Skip if already subscribed
    if (this.unsubscribers.has(conversationId)) {
      return
    }

    const unsubscribe = dmCallSignaling.subscribeToConversation(
      conversationId,
      (signal) => this.handleCallSignal(conversationId, signal)
    )
    
    this.unsubscribers.set(conversationId, unsubscribe)
    console.log(`📡 Subscribed to calls for conversation: ${conversationId}`)
  }

  /**
   * Add a new conversation to listen to (when DM list updates)
   */
  addConversation(conversationId: string): void {
    this.subscribeToConversation(conversationId)
  }

  /**
   * Remove conversation listener
   */
  removeConversation(conversationId: string): void {
    const unsubscribe = this.unsubscribers.get(conversationId)
    if (unsubscribe) {
      unsubscribe()
      this.unsubscribers.delete(conversationId)
      console.log(`📡 Unsubscribed from calls for conversation: ${conversationId}`)
    }
  }

  /**
   * Handle incoming call signals
   */
  private async handleCallSignal(conversationId: string, signal: CallSignal): Promise<void> {
    const toast = useToast()
    
    if (!this.currentUserId) return
    
    // Ignore our own signals
    if (signal.callerId === this.currentUserId) return

    switch (signal.type) {
      case 'initiate':
        await this.handleIncomingCall(conversationId, signal)
        break
        
      case 'accept':
        console.log('✅ Call accepted by other party')
        break
        
      case 'decline':
        const declineMsg = dmCallPermissions.getDeclineReasonMessage(signal.reason)
        toast.info(declineMsg)
        break
        
      case 'busy':
        toast.info('User is busy')
        break
        
      case 'timeout':
        toast.warning('No answer - call timed out')
        break
        
      case 'end':
        toast.info('Call ended')
        break
    }
  }

  /**
   * Handle incoming call with permission checks
   */
  private async handleIncomingCall(conversationId: string, signal: CallSignal): Promise<void> {
    if (!this.currentUserId) return

    console.log('📞 Incoming call from:', signal.callerId, 'Type:', signal.callType)

    // Check permissions
    const permissionCheck = await dmCallPermissions.canReceiveCall(
      signal.callerId,
      this.currentUserId,
      conversationId
    )

    if (!permissionCheck.allowed) {
      console.log('🚫 Auto-declining call:', permissionCheck.reason)
      await dmCallSignaling.declineCall(
        conversationId,
        this.currentUserId,
        permissionCheck.reason as any
      )
      return
    }

    // Load caller data
    const { userDataService } = await import('./userDataService')
    await userDataService.ensureUsersLoaded([signal.callerId])
    
    const callerData = userDataService.getUser(signal.callerId)
    
    const incomingCallData: IncomingCallData = {
      callerId: signal.callerId,
      callerName: callerData?.displayName || callerData?.username || 'Unknown',
      callerAvatar: callerData?.avatarUrl || '/default_avatar.png',
      callType: signal.callType,
      conversationId,
      timestamp: signal.timestamp
    }

    // Set incoming call data
    this.incomingCall.value = incomingCallData
    this.showIncomingCallModal.value = true
    
    // Notify callback if set
    if (this.onIncomingCallCallback) {
      this.onIncomingCallCallback(incomingCallData)
    }

    console.log('📞 Showing incoming call modal')
  }

  /**
   * Set callback for incoming calls (optional)
   */
  setIncomingCallCallback(callback: (call: IncomingCallData) => void): void {
    this.onIncomingCallCallback = callback
  }

  /**
   * Dismiss incoming call
   */
  dismissIncomingCall(): void {
    this.incomingCall.value = null
    this.showIncomingCallModal.value = false
  }

  /**
   * Cleanup all subscriptions
   */
  cleanup(): void {
    console.log('🧹 Cleaning up global call listener')
    this.unsubscribers.forEach(unsubscribe => unsubscribe())
    this.unsubscribers.clear()
    this.currentUserId = null
    this.incomingCall.value = null
    this.showIncomingCallModal.value = false
  }
}

// Singleton instance
export const globalDMCallListener = new GlobalDMCallListenerService()

