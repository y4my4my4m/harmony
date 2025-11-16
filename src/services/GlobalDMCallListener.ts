/**
 * Global DM Call Listener
 * SIMPLE: Subscribe to ONE channel per user: dm-calls:{userId}
 * No need to know conversation IDs in advance!
 */

import { ref } from 'vue'
import { supabase } from '@/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { dmCallPermissions } from './DMCallPermissions'
import { useToast } from 'vue-toastification'
import type { CallSignal } from './DMCallSignaling'

export interface IncomingCallData {
  callerId: string
  callerName: string
  callerAvatar: string
  callType: 'voice' | 'video'
  conversationId: string
  timestamp: number
}

class GlobalDMCallListenerService {
  private userChannel: RealtimeChannel | null = null
  private currentUserId: string | null = null
  
  // Reactive state for incoming calls
  public incomingCall = ref<IncomingCallData | null>(null)
  public showIncomingCallModal = ref(false)

  /**
   * Initialize: Just subscribe to dm-calls:{userId}
   */
  async initialize(userId: string): Promise<void> {
    // Don't re-initialize if already done
    if (this.userChannel && this.currentUserId === userId) {
      console.log('ℹ️ Global call listener already initialized for this user')
      return
    }
    
    // Cleanup old channel if exists
    if (this.userChannel) {
      this.userChannel.unsubscribe()
    }
    
    this.currentUserId = userId
    const channelName = `dm-calls:${userId}`
    
    console.log(`📞 ================================================`)
    console.log(`📞 INITIALIZING GLOBAL CALL LISTENER`)
    console.log(`📞 User: ${userId}`)
    console.log(`📞 Channel: ${channelName}`)
    console.log(`📞 ================================================`)
    
    this.userChannel = supabase.channel(channelName)
    
    this.userChannel
      .on('broadcast', { event: 'incoming-call' }, (payload) => {
        const signal = payload.payload as CallSignal
        console.log('📞 ======== CALL SIGNAL RECEIVED ========')
        console.log('📞 Type:', signal.type)
        console.log('📞 From:', signal.callerId)
        console.log('📞 Call Type:', signal.callType)
        console.log('📞 Conversation:', signal.conversationId)
        console.log('📞 ======================================')
        
        this.handleCallSignal(signal)
      })
      .subscribe((status) => {
        console.log(`📡 Global call channel status: ${status}`)
        if (status === 'SUBSCRIBED') {
          console.log('✅ ==========================================')
          console.log('✅ GLOBAL CALL LISTENER READY!')
          console.log('✅ You can now receive calls from ANYWHERE')
          console.log('✅ ==========================================')
        }
      })
  }

  /**
   * Handle incoming call signals
   */
  private async handleCallSignal(signal: CallSignal): Promise<void> {
    const toast = useToast()
    
    if (!this.currentUserId) {
      console.error('❌ No current user - cannot handle call')
      return
    }
    
    // Ignore our own signals
    if (signal.callerId === this.currentUserId) {
      console.log('ℹ️ Ignoring own call signal')
      return
    }

    console.log('📞 Processing call signal type:', signal.type)

    switch (signal.type) {
      case 'initiate':
        await this.handleIncomingCall(signal.conversationId, signal)
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
    if (!this.currentUserId) {
      console.error('❌ No current user ID')
      return
    }

    console.log('📞 ======== PROCESSING INCOMING CALL ========')
    console.log('📞 From:', signal.callerId)
    console.log('📞 To:', this.currentUserId)
    console.log('📞 Type:', signal.callType)
    console.log('📞 Conversation:', conversationId)

    // Check permissions
    const permissionCheck = await dmCallPermissions.canReceiveCall(
      signal.callerId,
      this.currentUserId,
      conversationId
    )

    console.log('🔍 Permission result:', permissionCheck)

    if (!permissionCheck.allowed) {
      console.log('🚫 Auto-declining:', permissionCheck.reason)
      // Send decline signal back
      const { dmCallSignaling } = await import('./DMCallSignaling')
      await dmCallSignaling.declineCall(
        conversationId,
        this.currentUserId,
        permissionCheck.reason as any
      )
      return
    }

    // Load caller data
    console.log('📞 Loading caller data...')
    const { userDataService } = await import('./userDataService')
    await userDataService.ensureUsersLoaded([signal.callerId])
    
    const callerData = userDataService.getUser(signal.callerId)
    console.log('📞 Caller data loaded:', callerData?.displayName || callerData?.username)

    const incomingCallData: IncomingCallData = {
      callerId: signal.callerId,
      callerName: callerData?.displayName || callerData?.username || 'Unknown',
      callerAvatar: callerData?.avatarUrl || '/default_avatar.png',
      callType: signal.callType,
      conversationId,
      timestamp: signal.timestamp
    }

    // Set state
    this.incomingCall.value = incomingCallData
    this.showIncomingCallModal.value = true
    
    console.log('📞 ======== MODAL STATE UPDATED ========')
    console.log('📞 showIncomingCallModal:', this.showIncomingCallModal.value)
    console.log('📞 incomingCall:', this.incomingCall.value)
    console.log('📞 ======================================')
    
    // Check DOM after a moment
    setTimeout(() => {
      const modals = document.querySelectorAll('.incoming-call-overlay')
      console.log('📞 Modal elements in DOM:', modals.length)
      if (modals.length === 0) {
        console.error('❌ MODAL NOT RENDERED!')
      } else {
        console.log('✅ Modal is in DOM')
      }
    }, 100)
  }

  /**
   * Dismiss incoming call
   */
  dismissIncomingCall(): void {
    this.incomingCall.value = null
    this.showIncomingCallModal.value = false
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.userChannel !== null
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    console.log('🧹 Cleaning up global call listener')
    if (this.userChannel) {
      this.userChannel.unsubscribe()
      this.userChannel = null
    }
    this.currentUserId = null
    this.incomingCall.value = null
    this.showIncomingCallModal.value = false
  }
}

// Singleton instance
export const globalDMCallListener = new GlobalDMCallListenerService()
