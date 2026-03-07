/**
 * Global DM Call Listener
 * SIMPLE: Subscribe to ONE channel per user: dm-calls:{userId}
 * No need to know conversation IDs in advance!
 */

import { ref } from 'vue'
import { supabase } from '@/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { dmCallPermissions } from './DMCallPermissions'
import { dmCallSignaling, type CallSignal } from './DMCallSignaling'
import { authContextService } from './AuthContextService'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'

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
   * Initialize: Subscribe to dm-calls:{profileId}
   * Resolves the profile ID from auth user ID so signals match what callers send.
   */
  async initialize(authUserId: string): Promise<void> {
    // Resolve auth user ID to profile ID (callers send to dm-calls:{profileId})
    let profileId: string | null = null
    try {
      profileId = await authContextService.getCurrentProfileId()
    } catch {
      // authContextService failed -- try a direct DB lookup as fallback
      debug.warn('⚠️ authContextService failed, trying direct profile lookup')
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id')
          .eq('auth_user_id', authUserId)
          .single()
        profileId = data?.id ?? null
      } catch {
        debug.error('❌ Direct profile lookup also failed')
      }
    }
    
    if (!profileId) {
      debug.error('❌ Could not resolve profile ID for call listener - call notifications will not work until next login')
      return
    }
    
    // Don't re-initialize if already done
    if (this.userChannel && this.currentUserId === profileId) {
      debug.log('ℹ️ Global call listener already initialized for this user')
      return
    }
    
    // Cleanup old channel if exists
    if (this.userChannel) {
      this.userChannel.unsubscribe()
    }
    
    this.currentUserId = profileId
    const channelName = `dm-calls:${profileId}`
    
    debug.log(`📞 ================================================`)
    debug.log(`📞 INITIALIZING GLOBAL CALL LISTENER`)
    debug.log(`📞 User: ${profileId}`)
    debug.log(`📞 Channel: ${channelName}`)
    debug.log(`📞 ================================================`)
    
    this.userChannel = supabase.channel(channelName)
    
    this.userChannel
      .on('broadcast', { event: 'incoming-call' }, (payload) => {
        const signal = payload.payload as CallSignal
        debug.log('📞 ======== CALL SIGNAL RECEIVED ========')
        debug.log('📞 Type:', signal.type)
        debug.log('📞 From:', signal.callerId)
        debug.log('📞 Call Type:', signal.callType)
        debug.log('📞 Conversation:', signal.conversationId)
        debug.log('📞 ======================================')
        
        this.handleCallSignal(signal)
      })
      .subscribe((status) => {
        debug.log(`📡 Global call channel status: ${status}`)
        if (status === 'SUBSCRIBED') {
          debug.log('✅ ==========================================')
          debug.log('✅ GLOBAL CALL LISTENER READY!')
          debug.log('✅ You can now receive calls from ANYWHERE')
          debug.log('✅ ==========================================')
        }
      })
  }

  /**
   * Handle incoming call signals
   */
  private async handleCallSignal(signal: CallSignal): Promise<void> {
    const toast = useToast()
    
    if (!this.currentUserId) {
      debug.error('❌ No current user - cannot handle call')
      return
    }
    
    // Ignore our own signals
    if (signal.callerId === this.currentUserId) {
      debug.log('ℹ️ Ignoring own call signal')
      return
    }

    debug.log('📞 Processing call signal type:', signal.type)

    switch (signal.type) {
      case 'initiate':
        await this.handleIncomingCall(signal.conversationId, signal)
        break
        
      case 'accept':
        debug.log('✅ Call accepted by other party')
        // Clear timeout since call was answered
        const activeCall = dmCallSignaling.getActiveCall(signal.conversationId)
        if (activeCall?.timeoutTimer) {
          debug.log('⏰ Clearing timeout timer - call was accepted')
          clearTimeout(activeCall.timeoutTimer)
          activeCall.timeoutTimer = undefined
        }
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
      debug.error('❌ No current user ID')
      return
    }

    debug.log('📞 ======== PROCESSING INCOMING CALL ========')
    debug.log('📞 From:', signal.callerId)
    debug.log('📞 To:', this.currentUserId)
    debug.log('📞 Type:', signal.callType)
    debug.log('📞 Conversation:', conversationId)

    // Check permissions
    const permissionCheck = await dmCallPermissions.canReceiveCall(
      signal.callerId,
      this.currentUserId,
      conversationId
    )

    debug.log('🔍 Permission result:', permissionCheck)

    if (!permissionCheck.allowed) {
      debug.log('🚫 Auto-declining:', permissionCheck.reason)
      // Send decline signal back
      await dmCallSignaling.declineCall(
        conversationId,
        this.currentUserId,
        permissionCheck.reason as any
      )
      return
    }

    // Load caller data
    debug.log('📞 Loading caller data...')
    const { userDataService } = await import('./userDataService')
    await userDataService.ensureUsersLoaded([signal.callerId])
    
    const callerData = userDataService.getUser(signal.callerId)
    debug.log('📞 Caller data loaded:', callerData?.displayName || callerData?.username)

    const incomingCallData: IncomingCallData = {
      callerId: signal.callerId,
      callerName: callerData?.displayName || callerData?.username || 'Unknown',
      callerAvatar: callerData?.avatarUrl || '/default_avatar.webp',
      callType: signal.callType,
      conversationId,
      timestamp: signal.timestamp
    }

    // Set state
    this.incomingCall.value = incomingCallData
    this.showIncomingCallModal.value = true
    
    debug.log('📞 ======== MODAL STATE UPDATED ========')
    debug.log('📞 showIncomingCallModal:', this.showIncomingCallModal.value)
    debug.log('📞 incomingCall:', this.incomingCall.value)
    debug.log('📞 ======================================')
    
    // Check DOM after a moment
    setTimeout(() => {
      const modals = document.querySelectorAll('.incoming-call-overlay')
      debug.log('📞 Modal elements in DOM:', modals.length)
      if (modals.length === 0) {
        debug.error('❌ MODAL NOT RENDERED!')
      } else {
        debug.log('✅ Modal is in DOM')
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
    debug.log('🧹 Cleaning up global call listener')
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
