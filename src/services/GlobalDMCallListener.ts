/**
 * Global DM Call Listener
 *
 * One channel per user, dm-calls:{profileId}, plus federated-calls:{profileId}.
 * Receives incoming calls without knowing conversation ids in advance.
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
  // Federated call fields
  isFederated?: boolean
  callerFederatedId?: string
  livekitUrl?: string
  roomName?: string
  callId?: string
}

class GlobalDMCallListenerService {
  private userChannel: RealtimeChannel | null = null
  private federatedChannel: RealtimeChannel | null = null
  private currentUserId: string | null = null
  // Auto-dismiss for rings whose caller died before sending cancel or timeout.
  private ringDismissTimer: ReturnType<typeof setTimeout> | null = null
  private readonly RING_DISMISS_MS = 45000

  public incomingCall = ref<IncomingCallData | null>(null)
  public showIncomingCallModal = ref(false)

  private armRingDismissTimer(conversationId: string): void {
    if (this.ringDismissTimer) clearTimeout(this.ringDismissTimer)
    this.ringDismissTimer = setTimeout(() => {
      this.ringDismissTimer = null
      if (this.incomingCall.value?.conversationId === conversationId) {
        debug.log('⏰ Incoming call ring expired without caller signal - dismissing')
        this.dismissIncomingCall()
      }
    }, this.RING_DISMISS_MS)
  }

  /**
   * Resolves the auth user id to a profile id, then subscribes. Callers
   * address dm-calls:{profileId}, so the auth id will not match.
   */
  async initialize(authUserId: string): Promise<void> {
    let profileId: string | null = null
    try {
      profileId = await authContextService.getCurrentProfileId()
    } catch {
      debug.warn('authContextService failed, trying direct profile lookup')
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id')
          .eq('auth_user_id', authUserId)
          .single()
        profileId = data?.id ?? null
      } catch {
        debug.error('Direct profile lookup also failed')
      }
    }
    
    if (!profileId) {
      debug.error('Could not resolve profile ID for call listener - call notifications will not work until next login')
      return
    }
    
    if (this.userChannel && this.currentUserId === profileId) {
      debug.log('ℹGlobal call listener already initialized for this user')
      return
    }
    
    if (this.userChannel) {
      this.userChannel.unsubscribe()
      this.userChannel = null
    }

    if (this.federatedChannel) {
      this.federatedChannel.unsubscribe()
      this.federatedChannel = null
    }

    this.currentUserId = profileId
    const channelName = `dm-calls:${profileId}`
    
    debug.log(`================================================`)
    debug.log(`INITIALIZING GLOBAL CALL LISTENER`)
    debug.log(`User: ${profileId}`)
    debug.log(`Channel: ${channelName}`)
    debug.log(`================================================`)
    
    this.userChannel = supabase.channel(channelName)
    
    this.userChannel
      .on('broadcast', { event: 'incoming-call' }, (payload) => {
        const signal = payload.payload as CallSignal
        debug.log('======== CALL SIGNAL RECEIVED ========')
        debug.log('Type:', signal.type)
        debug.log('From:', signal.callerId)
        debug.log('Call Type:', signal.callType)
        debug.log('Conversation:', signal.conversationId)
        debug.log('======================================')
        
        this.handleCallSignal(signal)
      })
      .subscribe((status) => {
        debug.log(`Global call channel status: ${status}`)
        if (status === 'SUBSCRIBED') {
          debug.log('==========================================')
          debug.log('GLOBAL CALL LISTENER READY!')
          debug.log('You can now receive calls from ANYWHERE')
          debug.log('==========================================')
        }
      })

    // Federation backend broadcasts remote-instance calls on this channel.
    const federatedChannelName = `federated-calls:${profileId}`
    debug.log(`Subscribing to federated call channel: ${federatedChannelName}`)
    
    this.federatedChannel = supabase.channel(federatedChannelName)
    
    this.federatedChannel
      .on('broadcast', { event: 'incoming-call' }, (payload) => {
        debug.log('======== FEDERATED CALL RECEIVED ========')
        debug.log('Payload:', JSON.stringify(payload.payload))
        debug.log('=========================================')
        this.handleFederatedCallSignal(payload.payload)
      })
      .on('broadcast', { event: 'call-accepted' }, (payload) => {
        debug.log('[Federated] Call accepted:', payload.payload)
        const { callId } = payload.payload
        const call = dmCallSignaling.getActiveCall(callId)
        if (call?.timeoutTimer) {
          clearTimeout(call.timeoutTimer)
          call.timeoutTimer = undefined
        }
      })
      .on('broadcast', { event: 'call-rejected' }, (payload) => {
        debug.log('[Federated] Call rejected:', payload.payload)
        const toast = useToast()
        toast.info('Call declined')
      })
      .on('broadcast', { event: 'call-ended' }, (payload) => {
        debug.log('[Federated] Call ended:', payload.payload)
        this.dismissIncomingCall()
      })
      .subscribe((status) => {
        debug.log(`Federated call channel status: ${status}`)
        if (status === 'SUBSCRIBED') {
          debug.log('Federated call listener ready')
        }
      })
  }

  private async handleCallSignal(signal: CallSignal): Promise<void> {
    const toast = useToast()
    
    if (!this.currentUserId) {
      debug.error('No current user - cannot handle call')
      return
    }
    
    // Broadcasts echo back to the sender.
    if (signal.callerId === this.currentUserId) {
      debug.log('ℹIgnoring own call signal')
      return
    }

    debug.log('Processing call signal type:', signal.type)

    switch (signal.type) {
      case 'initiate':
        dmCallSignaling.registerRemoteCall(
          signal.conversationId,
          signal.callerId,
          signal.callType,
          signal.systemMessageId
        )
        await this.handleIncomingCall(signal.conversationId, signal)
        break
        
      case 'accept': {
        debug.log('Call accepted by other party')
        dmCallSignaling.handleRemoteSignal(signal)
        const activeCall = dmCallSignaling.getActiveCall(signal.conversationId)
        if (activeCall?.timeoutTimer) {
          debug.log('Clearing timeout timer - call was accepted')
          clearTimeout(activeCall.timeoutTimer)
          activeCall.timeoutTimer = undefined
        }
        break
      }

      case 'decline': {
        const declineMsg = dmCallPermissions.getDeclineReasonMessage(signal.reason)
        toast.info(declineMsg)
        break
      }
        
      case 'busy':
        toast.info('User is busy')
        break
        
      case 'timeout':
        debug.log('⏰ Call timed out - dismissing incoming call modal')
        dmCallSignaling.handleRemoteSignal(signal)
        this.dismissIncomingCall()
        // info routes to the corner toast; warn would go top-center.
        toast.info('Missed call')
        break
        
      case 'end':
        debug.log('Call ended/cancelled - dismissing incoming call modal')
        dmCallSignaling.handleRemoteSignal(signal)
        this.dismissIncomingCall()
        break
      
      case 'join':
      case 'leave':
        dmCallSignaling.handleRemoteSignal(signal)
        break
    }
  }

  /** Permission gate runs before any UI or call-state side effect. */
  private async handleIncomingCall(conversationId: string, signal: CallSignal): Promise<void> {
    if (!this.currentUserId) {
      debug.error('No current user ID')
      return
    }

    debug.log('======== PROCESSING INCOMING CALL ========')
    debug.log('From:', signal.callerId)
    debug.log('To:', this.currentUserId)
    debug.log('Type:', signal.callType)
    debug.log('Conversation:', conversationId)

    const permissionCheck = await dmCallPermissions.canReceiveCall(
      signal.callerId,
      this.currentUserId,
      conversationId
    )

    debug.log('Permission result:', permissionCheck)

    if (!permissionCheck.allowed) {
      debug.log('Auto-declining:', permissionCheck.reason)
      await dmCallSignaling.declineCall(
        conversationId,
        this.currentUserId,
        permissionCheck.reason as any
      )
      return
    }

    debug.log('Loading caller data...')
    const { userDataService } = await import('./userDataService')
    await userDataService.ensureUsersLoaded([signal.callerId])
    
    const callerData = userDataService.getUser(signal.callerId)
    debug.log('Caller data loaded:', callerData?.displayName || callerData?.username)

    const incomingCallData: IncomingCallData = {
      callerId: signal.callerId,
      callerName: callerData?.displayName || callerData?.username || 'Unknown',
      callerAvatar: callerData?.avatarUrl || '/default_avatar.webp',
      callType: signal.callType,
      conversationId,
      timestamp: signal.timestamp
    }

    this.incomingCall.value = incomingCallData
    this.showIncomingCallModal.value = true
    this.armRingDismissTimer(conversationId)

    debug.log('======== MODAL STATE UPDATED ========')
    debug.log('showIncomingCallModal:', this.showIncomingCallModal.value)
    debug.log('incomingCall:', this.incomingCall.value)
    debug.log('======================================')
    
    setTimeout(() => {
      const modals = document.querySelectorAll('.incoming-call-overlay')
      debug.log('Modal elements in DOM:', modals.length)
      if (modals.length === 0) {
        debug.error('MODAL NOT RENDERED!')
      } else {
        debug.log('Modal is in DOM')
      }
    }, 100)
  }

  /** Handles the federation backend's incoming-call broadcast. */
  private async handleFederatedCallSignal(payload: {
    callId: string
    callerId: string
    callerName: string
    callerAvatar: string
    callerFederatedId: string
    callType: 'voice' | 'video'
    conversationId: string
    livekitUrl: string
    roomName: string
  }): Promise<void> {
    if (!this.currentUserId) return
    
    const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
    const voiceStore = useUnifiedVoiceChannelStore()
    if (voiceStore.isConnected) {
      debug.log('[Federated] Already in a call, ignoring incoming')
      return
    }

    // BUGS.md H5: federated calls run the same permission gate as the local
    // path, before any UI or call-state side effect. Skipping it let any
    // remote actor ring a blocked / DND / muted user. No federation-side
    // decline channel exists, so a denial only suppresses the local ring and
    // the caller's own timeout ends the call.
    const permissionCheck = await dmCallPermissions.canReceiveCall(
      payload.callerId,
      this.currentUserId,
      payload.conversationId,
    )
    if (!permissionCheck.allowed) {
      debug.log(`[Federated] Auto-rejecting incoming call: ${permissionCheck.reason}`)
      return
    }

    dmCallSignaling.registerRemoteCall(
      payload.conversationId,
      payload.callerId,
      payload.callType
    )
    
    const call = dmCallSignaling.getActiveCall(payload.conversationId)
    if (call) {
      call.isFederated = true
      call.callerFederatedId = payload.callerFederatedId
      call.livekitUrl = payload.livekitUrl
      call.roomName = payload.roomName
    }

    const { getAvatarUrl } = await import('@/utils/avatarUtils')

    const incomingCallData: IncomingCallData = {
      callerId: payload.callerId,
      callerName: payload.callerName || 'Unknown',
      callerAvatar: getAvatarUrl(payload.callerAvatar) || '/default_avatar.webp',
      callType: payload.callType,
      conversationId: payload.conversationId,
      timestamp: Date.now(),
      isFederated: true,
      callerFederatedId: payload.callerFederatedId,
      livekitUrl: payload.livekitUrl,
      roomName: payload.roomName,
      callId: payload.callId,
    }

    this.incomingCall.value = incomingCallData
    this.showIncomingCallModal.value = true
    this.armRingDismissTimer(payload.conversationId)

    debug.log('[Federated] Showing incoming call modal')
  }

  dismissIncomingCall(): void {
    if (this.ringDismissTimer) {
      clearTimeout(this.ringDismissTimer)
      this.ringDismissTimer = null
    }
    this.incomingCall.value = null
    this.showIncomingCallModal.value = false
  }

  isInitialized(): boolean {
    return this.userChannel !== null
  }

  cleanup(): void {
    debug.log('Cleaning up global call listener')
    if (this.userChannel) {
      this.userChannel.unsubscribe()
      this.userChannel = null
    }
    if (this.federatedChannel) {
      this.federatedChannel.unsubscribe()
      this.federatedChannel = null
    }
    this.currentUserId = null
    this.incomingCall.value = null
    this.showIncomingCallModal.value = false
  }
}

export const globalDMCallListener = new GlobalDMCallListenerService()
