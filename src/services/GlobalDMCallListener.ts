/**
 * Global DM Call Listener
 *
 * One private channel per user, dm-calls:{profileId}: its owner alone reads it,
 * no client sends on it (rings come from ring_dm_call), plus the federated_call:*
 * events of the private user channel (UserEventChannel).
 * Receives incoming calls without knowing conversation ids in advance.
 */

import { ref, watch } from 'vue'
import { supabase } from '@/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { dmCallPermissions } from './DMCallPermissions'
import { userEventChannel } from './UserEventChannel'
import { dmCallSignaling, type CallSignal, type FederatedCallEvent } from './DMCallSignaling'
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
  private federatedOff: (() => void) | null = null
  private currentUserId: string | null = null
  // Auto-dismiss for rings whose caller died before sending cancel or timeout.
  private ringDismissTimer: ReturnType<typeof setTimeout> | null = null
  private readonly RING_DISMISS_MS = 45000
  // Ring per conversation whose permission gate is in flight; end or timeout drops it.
  private pendingRings = new Map<string, CallSignal>()
  // Conversations whose ring was silenced by mute: no ringtone, popup or missed-call toast.
  private silencedRings = new Set<string>()
  private ringTimeoutOff: (() => void) | null = null
  // Per conversation, the wait for the join of an answer whose ring already ended.
  private lostAnswerWatches = new Map<string, () => void>()
  private readonly LOST_ANSWER_WATCH_MS = 10000

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

    this.federatedOff?.()
    this.federatedOff = null
    this.ringTimeoutOff ??= dmCallSignaling.onRingTimeout((conversationId) => {
      void this.handleOwnRingTimeout(conversationId)
    })

    this.currentUserId = profileId
    const channelName = `dm-calls:${profileId}`
    
    debug.log(`================================================`)
    debug.log(`INITIALIZING GLOBAL CALL LISTENER`)
    debug.log(`User: ${profileId}`)
    debug.log(`Channel: ${channelName}`)
    debug.log(`================================================`)
    
    this.userChannel = supabase.channel(channelName, { config: { private: true } })
    
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

    // Federation backend sends remote-instance call events on the private user
    // channel; only this user subscribes or sends there.
    userEventChannel.connect(profileId)
    const offs = [
      userEventChannel.on('federated_call:incoming', (payload) => {
        debug.log('======== FEDERATED CALL RECEIVED ========')
        debug.log('Payload:', JSON.stringify(payload))
        debug.log('=========================================')
        this.handleFederatedCallSignal(payload as any)
      }),
      userEventChannel.on('federated_call:accepted', (payload) => {
        debug.log('[Federated] Call accepted:', payload)
        dmCallSignaling.handleFederatedCallEvent('accepted', payload as FederatedCallEvent)
      }),
      userEventChannel.on('federated_call:rejected', (payload) => {
        debug.log('[Federated] Call rejected:', payload)
        dmCallSignaling.handleFederatedCallEvent('rejected', payload as FederatedCallEvent)
        void this.leaveFederatedRoom(payload as FederatedCallEvent)
        useToast().info('Call declined')
      }),
      userEventChannel.on('federated_call:ended', (payload) => {
        debug.log('[Federated] Call ended:', payload)
        const event = payload as FederatedCallEvent
        if (event.conversationId) this.silencedRings.delete(event.conversationId)
        if (!event.conversationId || this.incomingCall.value?.conversationId === event.conversationId) {
          this.dismissIncomingCall()
        }
        dmCallSignaling.handleFederatedCallEvent('ended', event)
        void this.leaveFederatedRoom(event)
      }),
    ]
    this.federatedOff = () => offs.forEach((off) => off())
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
        this.lostAnswerWatches.get(signal.conversationId)?.()
        this.pendingRings.set(signal.conversationId, signal)
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
      case 'end': {
        debug.log(`Call ${signal.type} - dismissing incoming call modal`)
        this.pendingRings.delete(signal.conversationId)
        const silenced = this.silencedRings.delete(signal.conversationId)
        // The ring ends only while the caller saw no answer: an answer from
        // this client crossed it in flight.
        const answered = !!dmCallSignaling.getActiveCall(signal.conversationId)?.participants.includes(this.currentUserId)
        dmCallSignaling.handleRemoteSignal(signal)
        this.dismissIncomingCall(signal.conversationId)
        if (answered) {
          void this.endLostAnswer(signal.conversationId)
        } else if (signal.type === 'timeout' && !silenced) {
          // info routes to the corner toast; warn would go top-center.
          toast.info('Missed call')
        }
        break
      }
      
      case 'join':
      case 'leave':
        dmCallSignaling.handleRemoteSignal(signal)
        break
    }
  }

  /**
   * Permission gate runs before any UI or call-state side effect. An allowed
   * ring is recorded and its conversation followed until the call ends; a
   * silent ring stops there.
   */
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

    // Cancelled, timed out or rung again while the gate ran.
    if (this.pendingRings.get(conversationId) !== signal) return
    this.pendingRings.delete(conversationId)

    if (!permissionCheck.allowed) {
      debug.log('Auto-declining:', permissionCheck.reason)
      await dmCallSignaling.declineCall(
        conversationId,
        this.currentUserId,
        permissionCheck.reason as any
      )
      return
    }

    dmCallSignaling.registerRemoteCall(
      conversationId,
      signal.callerId,
      signal.callType,
      signal.systemMessageId
    )
    dmCallSignaling.followCall(conversationId)

    if (permissionCheck.silent) {
      debug.log('Caller or conversation muted - ring silenced')
      this.silencedRings.add(conversationId)
      return
    }
    this.silencedRings.delete(conversationId)

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

    // BUGS.md H5: federated calls run the same permission gate as the local
    // path, before any UI or call-state side effect. Skipping it let any
    // remote actor ring a blocked / DND user. No federation-side decline
    // channel exists, so a denial (busy included) only suppresses the local
    // ring and the caller's own timeout ends the call.
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

    if (permissionCheck.silent) {
      debug.log('[Federated] Caller or conversation muted - ring silenced')
      this.silencedRings.add(payload.conversationId)
      return
    }
    this.silencedRings.delete(payload.conversationId)

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

  /** Caller side: this client's ring went unanswered. Leaves the call's room. */
  private async handleOwnRingTimeout(conversationId: string): Promise<void> {
    const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
    const voiceStore = useUnifiedVoiceChannelStore()
    const room = voiceStore.effectiveChannelId
    const inCall = room === `dm-${conversationId}`
      || (!!room?.startsWith('federated-dm-') && dmCallSignaling.conversationForRoom(room) === conversationId)
    if (inCall) await voiceStore.leaveVoiceChannel()
    useToast().info('No answer')
  }

  /**
   * This client answered a ring that ended before the caller saw the answer.
   * Leaves the call's room now, or when the answer's join reaches it within
   * LOST_ANSWER_WATCH_MS. A new ring, or a call this client places, in the
   * conversation cancels the wait.
   */
  private async endLostAnswer(conversationId: string): Promise<void> {
    const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
    const voiceStore = useUnifiedVoiceChannelStore()
    const room = `dm-${conversationId}`
    const leave = () => {
      void voiceStore.leaveVoiceChannel()
      useToast().info('Call ended')
    }
    this.lostAnswerWatches.get(conversationId)?.()
    if (voiceStore.effectiveChannelId === room) {
      leave()
      return
    }

    const stop = watch(() => voiceStore.effectiveChannelId, (current) => {
      if (dmCallSignaling.getActiveCall(conversationId)?.callerId === this.currentUserId) return cancel()
      if (current !== room) return
      cancel()
      leave()
    })
    const expiry = setTimeout(() => cancel(), this.LOST_ANSWER_WATCH_MS)
    const cancel = () => {
      stop()
      clearTimeout(expiry)
      if (this.lostAnswerWatches.get(conversationId) === cancel) this.lostAnswerWatches.delete(conversationId)
    }
    this.lostAnswerWatches.set(conversationId, cancel)
  }

  /** Leaves the voice room of a federated call the remote party rejected or ended. */
  private async leaveFederatedRoom(event: FederatedCallEvent): Promise<void> {
    if (!event.roomName) return
    const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
    const voiceStore = useUnifiedVoiceChannelStore()
    if (voiceStore.currentChannelId === event.roomName || voiceStore.optimisticChannelId === event.roomName) {
      await voiceStore.leaveVoiceChannel()
    }
  }

  /** With a conversation id, dismisses only the ring of that conversation. */
  dismissIncomingCall(conversationId?: string): void {
    if (conversationId && this.incomingCall.value && this.incomingCall.value.conversationId !== conversationId) return
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
    this.federatedOff?.()
    this.federatedOff = null
    this.ringTimeoutOff?.()
    this.ringTimeoutOff = null
    this.lostAnswerWatches.forEach(cancel => cancel())
    this.currentUserId = null
    this.pendingRings.clear()
    this.silencedRings.clear()
    this.incomingCall.value = null
    this.showIncomingCallModal.value = false
  }
}

export const globalDMCallListener = new GlobalDMCallListenerService()
