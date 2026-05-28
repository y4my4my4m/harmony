/**
 * DM Call Signaling Service
 * Handles call initiation, ringing, accept/decline via Supabase real-time
 * Supports federated calls via ActivityPub voice extensions
 * No database needed - pure real-time signaling
 */

import { ref } from 'vue'
import { supabase } from '@/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { debug } from '@/utils/debug'

export interface CallSignal {
  type: 'initiate' | 'accept' | 'decline' | 'end' | 'join' | 'leave' | 'busy' | 'timeout'
  callerId: string
  callType: 'voice' | 'video'
  timestamp: number
  conversationId: string
  reason?: 'timeout' | 'busy' | 'blocked' | 'dnd' // Decline/busy reasons
  systemMessageId?: string // DB message ID for the call system message
  // Federated call fields
  isFederated?: boolean
  callerFederatedId?: string
  livekitUrl?: string
  roomName?: string
}

export interface ActiveCall {
  conversationId: string
  channelId: string // dm-{conversationId}
  callType: 'voice' | 'video'
  callerId: string
  receiverIds: string[] // who was called (for sending cancel/timeout notifications)
  participants: string[] // user IDs currently in call
  allParticipants: string[] // everyone who ever joined (for the ended message)
  startedAt: Date
  timeoutTimer?: number // Timer ID for call timeout
  systemMessageId: string | null // DB message ID for the call system message
  // Federated call fields
  isFederated?: boolean
  callerFederatedId?: string
  calleeFederatedId?: string
  livekitUrl?: string
  roomName?: string
}

export interface FederatedCallInfo {
  callerFederatedId: string
  calleeFederatedId: string
  callerInstanceUrl: string
  livekitUrl: string
  roomName: string
}

class DMCallSignalingService {
  private channels: Map<string, RealtimeChannel> = new Map()
  private activeCalls: Map<string, ActiveCall> = new Map()
  private listeners: Map<string, Set<(signal: CallSignal) => void>> = new Map()
  
  // Reactive counter so Vue computeds that read call state re-evaluate on changes.
  // Components should read callStateVersion.value inside their computed to track changes.
  public callStateVersion = ref(0)
  private bumpVersion() { this.callStateVersion.value++ }
  
  private setActiveCall(conversationId: string, call: ActiveCall) {
    this.activeCalls.set(conversationId, call)
    this.bumpVersion()
  }
  
  private deleteActiveCall(conversationId: string) {
    this.activeCalls.delete(conversationId)
    this.bumpVersion()
  }
  
  private readonly CALL_TIMEOUT_MS = 30000 // 30 seconds

  /**
   * Subscribe to call signals for a conversation
   */
  subscribeToConversation(conversationId: string, onSignal: (signal: CallSignal) => void): () => void {
    const channelName = `dm-call:${conversationId}`
    
    // Add listener
    if (!this.listeners.has(conversationId)) {
      this.listeners.set(conversationId, new Set())
    }
    this.listeners.get(conversationId)!.add(onSignal)
    
    // Create channel if doesn't exist
    if (!this.channels.has(conversationId)) {
      const channel = supabase.channel(channelName)
      
      channel
        .on('broadcast', { event: 'call-signal' }, (payload) => {
          const signal = payload.payload as CallSignal
          debug.log('📞 Received call signal:', {
            conversation: conversationId,
            type: signal.type,
            from: signal.callerId,
            callType: signal.callType
          })
          
          // Notify all listeners
          const listeners = this.listeners.get(conversationId)
          if (listeners) {
            debug.log(`📞 Notifying ${listeners.size} listener(s)`)
            listeners.forEach(listener => listener(signal))
          } else {
            debug.warn('📞 No listeners for conversation:', conversationId)
          }
        })
        .subscribe((status) => {
          debug.log(`📡 Call channel ${channelName} status:`, status)
        })
      
      this.channels.set(conversationId, channel)
    }
    
    // Return unsubscribe function
    return () => {
      const listeners = this.listeners.get(conversationId)
      if (listeners) {
        listeners.delete(onSignal)
        
        // If no more listeners, remove channel
        if (listeners.size === 0) {
          this.listeners.delete(conversationId)
          const channel = this.channels.get(conversationId)
          if (channel) {
            channel.unsubscribe()
            this.channels.delete(conversationId)
          }
        }
      }
    }
  }

  /**
   * Send a call signal on the conversation channel.
   * Creates a temporary channel if no subscription exists (e.g. when
   * accepting from the global incoming-call modal before DMHeader mounts).
   */
  async sendSignal(conversationId: string, signal: CallSignal): Promise<void> {
    debug.log('📤 Sending call signal:', {
      conversation: conversationId,
      type: signal.type,
      from: signal.callerId,
      callType: signal.callType
    })
    
    const existingChannel = this.channels.get(conversationId)
    
    if (existingChannel) {
      await existingChannel.send({
        type: 'broadcast',
        event: 'call-signal',
        payload: signal
      })
    } else {
      const channelName = `dm-call:${conversationId}`
      debug.log(`📤 No existing subscription - using temp channel: ${channelName}`)
      const tempChannel = supabase.channel(channelName)
      await new Promise<void>((resolve, reject) => {
        tempChannel.subscribe((status) => {
          if (status === 'SUBSCRIBED') resolve()
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(`Channel ${status}`))
        })
      })
      await tempChannel.send({
        type: 'broadcast',
        event: 'call-signal',
        payload: signal
      })
      await tempChannel.unsubscribe()
    }
    
    debug.log('✅ Call signal sent successfully')
  }

  /**
   * Initiate a call with timeout
   * Sends signal to the RECEIVER's user channel (dm-calls:{receiverId})
   */
  async initiateCall(
    conversationId: string,
    callerId: string,
    callType: 'voice' | 'video',
    receiverIds: string[] // Who to call
  ): Promise<void> {
    const startedAt = new Date()
    
    // Insert system message for the call
    let systemMessageId: string | null = null
    try {
      const { data: msg, error } = await supabase.from('messages').insert({
        user_id: callerId,
        conversation_id: conversationId,
        content: [{ type: 'text', text: 'started a call' }],
        is_system: true,
        metadata: {
          type: 'call_started',
          call_type: callType,
          started_at: startedAt.toISOString(),
          participants: [callerId],
        }
      }).select('id').single()
      if (error) {
        debug.error('Failed to insert call system message:', error.message)
      } else {
        systemMessageId = msg?.id ?? null
      }
    } catch (error) {
      debug.error('Failed to insert call system message:', error)
    }
    
    const signal: CallSignal = {
      type: 'initiate',
      callerId,
      callType,
      timestamp: Date.now(),
      conversationId,
      systemMessageId: systemMessageId ?? undefined,
    }
    
    // Setup timeout timer
    const timeoutTimer = window.setTimeout(() => {
      this.handleCallTimeout(conversationId, callerId)
    }, this.CALL_TIMEOUT_MS)
    
    // Track active call
    this.setActiveCall(conversationId, {
      conversationId,
      channelId: `dm-${conversationId}`,
      callType,
      callerId,
      receiverIds,
      participants: [callerId],
      allParticipants: [callerId],
      startedAt,
      timeoutTimer,
      systemMessageId,
    })
    
    // Send signal to each receiver's user channel
    for (const receiverId of receiverIds) {
      await this.sendSignalToUser(receiverId, signal)
    }
  }
  
  /**
   * Send signal to a specific user's channel
   */
  private async sendSignalToUser(userId: string, signal: CallSignal): Promise<void> {
    const channelName = `dm-calls:${userId}`
    debug.log(`📤 Sending call signal to user ${userId} on channel ${channelName}`)
    
    const tempChannel = supabase.channel(channelName)
    
    await new Promise<void>((resolve, reject) => {
      tempChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve()
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(`Channel ${status}`))
      })
    })
    
    await tempChannel.send({
      type: 'broadcast',
      event: 'incoming-call',
      payload: signal
    })
    
    debug.log('✅ Signal sent to user:', userId)
    
    await tempChannel.unsubscribe()
  }
  
  /**
   * Handle call timeout (no answer after 30 seconds)
   * Discord behavior: stop ringing on both sides, show "No Answer"
   */
  private async handleCallTimeout(conversationId: string, callerId: string): Promise<void> {
    const call = this.activeCalls.get(conversationId)
    if (!call) {
      debug.log('⏰ Timeout fired but call already ended/answered')
      return
    }
    
    // Only timeout if still ringing (only caller in participants)
    if (call.participants.length === 1 && call.participants[0] === callerId) {
      debug.log('⏰ Call timeout - no answer after 30 seconds')
      
      // Update system message to show missed call
      await this.finalizeCallMessage(call)
      
      const timeoutSignal: CallSignal = {
        type: 'timeout',
        callerId,
        callType: call.callType,
        timestamp: Date.now(),
        conversationId,
        reason: 'timeout'
      }
      
      // Broadcast on conversation channel (for the caller's DMHeader)
      await this.sendSignal(conversationId, timeoutSignal)
      
      // Also notify each receiver on their user channel so GlobalDMCallListener
      // can dismiss the incoming call modal
      for (const receiverId of call.receiverIds) {
        await this.sendSignalToUser(receiverId, timeoutSignal)
      }
      
      this.deleteActiveCall(conversationId)
    } else {
      debug.log('⏰ Timeout fired but call was answered (has', call.participants.length, 'participants)')
    }
  }

  /**
   * Accept a call
   */
  async acceptCall(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const call = this.activeCalls.get(conversationId)
    if (!call) return
    
    // Clear timeout timer since call was answered
    if (call.timeoutTimer) {
      debug.log('⏰ Clearing timeout timer - call accepted')
      clearTimeout(call.timeoutTimer)
      call.timeoutTimer = undefined
    }
    
    const signal: CallSignal = {
      type: 'accept',
      callerId: userId,
      callType: call.callType,
      timestamp: Date.now(),
      conversationId
    }
    
    // Add to participants
    if (!call.participants.includes(userId)) {
      call.participants.push(userId)
    }
    if (!call.allParticipants.includes(userId)) {
      call.allParticipants.push(userId)
    }
    
    // Broadcast on the conversation channel so the caller's DMHeader receives it
    await this.sendSignal(conversationId, signal)
    
    debug.log('✅ Accept signal sent on conversation channel:', conversationId)
  }

  /**
   * Decline a call
   */
  async declineCall(
    conversationId: string,
    userId: string,
    reason?: 'busy' | 'blocked' | 'dnd'
  ): Promise<void> {
    const call = this.activeCalls.get(conversationId)
    
    // Clear timeout timer if exists
    if (call?.timeoutTimer) {
      clearTimeout(call.timeoutTimer)
    }
    
    const signal: CallSignal = {
      type: reason === 'busy' ? 'busy' : 'decline',
      callerId: userId,
      callType: 'voice', // doesn't matter for decline
      timestamp: Date.now(),
      conversationId,
      reason
    }
    
    await this.sendSignal(conversationId, signal)
    
    // Remove from active calls
    this.deleteActiveCall(conversationId)
  }

  /**
   * End a call
   */
  async endCall(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const call = this.activeCalls.get(conversationId)
    
    // Clear timeout timer if exists
    if (call?.timeoutTimer) {
      clearTimeout(call.timeoutTimer)
    }
    
    // Finalize system message
    if (call) {
      await this.finalizeCallMessage(call)
    }
    
    const signal: CallSignal = {
      type: 'end',
      callerId: userId,
      callType: 'voice',
      timestamp: Date.now(),
      conversationId
    }
    
    // Remove from active calls
    this.deleteActiveCall(conversationId)
    
    await this.sendSignal(conversationId, signal)
  }

  /**
   * Join an ongoing call (for group DMs)
   */
  async joinCall(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const call = this.activeCalls.get(conversationId)
    if (!call) return
    
    const signal: CallSignal = {
      type: 'join',
      callerId: userId,
      callType: call.callType,
      timestamp: Date.now(),
      conversationId
    }
    
    // Add to participants
    if (!call.participants.includes(userId)) {
      call.participants.push(userId)
    }
    if (!call.allParticipants.includes(userId)) {
      call.allParticipants.push(userId)
    }
    
    await this.sendSignal(conversationId, signal)
  }

  /**
   * Leave a call (participant leaves but call continues)
   * If the caller leaves while still ringing (no one answered), this acts as
   * a cancel: sends 'end' to receivers so their incoming call UI dismisses.
   */
  async leaveCall(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const call = this.activeCalls.get(conversationId)
    if (!call) return
    
    // Clear timeout timer
    if (call.timeoutTimer) {
      clearTimeout(call.timeoutTimer)
      call.timeoutTimer = undefined
    }
    
    // Check if this is a caller-cancel (caller hangs up before anyone answered)
    const isCallerCancel = userId === call.callerId
      && call.participants.length === 1
      && call.participants[0] === userId
    
    // Remove from participants
    call.participants = call.participants.filter(id => id !== userId)
    
    if (isCallerCancel) {
      // Caller cancelled before anyone answered - treat as call end
      await this.finalizeCallMessage(call)
      this.deleteActiveCall(conversationId)
      
      const endSignal: CallSignal = {
        type: 'end',
        callerId: userId,
        callType: call.callType,
        timestamp: Date.now(),
        conversationId
      }
      
      // Notify on conversation channel
      await this.sendSignal(conversationId, endSignal)
      
      // Notify each receiver on their user channel so GlobalDMCallListener
      // dismisses the incoming call modal
      for (const receiverId of call.receiverIds) {
        await this.sendSignalToUser(receiverId, endSignal)
      }
    } else {
      const signal: CallSignal = {
        type: 'leave',
        callerId: userId,
        callType: call.callType,
        timestamp: Date.now(),
        conversationId
      }
      
      if (call.participants.length === 0) {
        await this.finalizeCallMessage(call)
        this.deleteActiveCall(conversationId)
      } else if (userId === call.callerId) {
        // The call initiator is leaving but others remain.
        // Finalize now since only the owner can update the message (RLS).
        await this.finalizeCallMessage(call)
        this.deleteActiveCall(conversationId)
      }
      
      await this.sendSignal(conversationId, signal)
    }
  }

  /**
   * Get active call for conversation (exposed for timeout clearing)
   */
  getActiveCall(conversationId: string): ActiveCall | undefined {
    return this.activeCalls.get(conversationId)
  }

  /**
   * Check if there's an active call
   */
  hasActiveCall(conversationId: string): boolean {
    return this.activeCalls.has(conversationId)
  }

  /**
   * Get participants in call
   */
  getCallParticipants(conversationId: string): string[] {
    return this.activeCalls.get(conversationId)?.participants || []
  }

  /**
   * Register a remote call (callee side) so hasActiveCall() works for all participants.
   * Called by GlobalDMCallListener when an initiate signal is received.
   */
  registerRemoteCall(
    conversationId: string,
    callerId: string,
    callType: 'voice' | 'video',
    systemMessageId?: string
  ): void {
    if (this.activeCalls.has(conversationId)) return
    
    this.setActiveCall(conversationId, {
      conversationId,
      channelId: `dm-${conversationId}`,
      callType,
      callerId,
      receiverIds: [],
      participants: [callerId],
      allParticipants: [callerId],
      startedAt: new Date(),
      systemMessageId: systemMessageId ?? null,
    })
    debug.log('📞 Registered remote call for conversation:', conversationId)
  }

  /**
   * Handle an incoming signal to update local activeCalls state.
   * Called by GlobalDMCallListener for end/leave/join signals.
   */
  handleRemoteSignal(signal: CallSignal): void {
    const call = this.activeCalls.get(signal.conversationId)
    
    switch (signal.type) {
      case 'accept':
      case 'join':
        if (call) {
          if (!call.participants.includes(signal.callerId)) {
            call.participants.push(signal.callerId)
          }
          if (!call.allParticipants.includes(signal.callerId)) {
            call.allParticipants.push(signal.callerId)
          }
          this.bumpVersion()
        }
        break
      case 'leave':
        if (call) {
          call.participants = call.participants.filter(id => id !== signal.callerId)
          if (call.participants.length === 0) {
            this.deleteActiveCall(signal.conversationId)
          } else {
            this.bumpVersion()
          }
        }
        break
      case 'end':
        this.deleteActiveCall(signal.conversationId)
        break
    }
  }

  /**
   * Update the system message to show the call has ended with duration info.
   * TODO: Replace with a SECURITY DEFINER RPC function so any conversation
   * participant can finalize, not just the message owner (callerId).
   */
  private async finalizeCallMessage(call: ActiveCall): Promise<void> {
    if (!call.systemMessageId) return
    
    const endedAt = new Date()
    const durationSeconds = Math.floor((endedAt.getTime() - call.startedAt.getTime()) / 1000)
    
    const newMetadata = {
      type: 'call_ended',
      call_type: call.callType,
      started_at: call.startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
      participants: call.allParticipants,
    }
    
    try {
      await supabase.from('messages').update({
        metadata: newMetadata
      }).eq('id', call.systemMessageId)
      
      debug.log('📞 Finalized call system message:', call.systemMessageId, 'duration:', durationSeconds, 's')
    } catch (error) {
      debug.error('Failed to finalize call system message:', error)
    }
    
    // Update the local DM message cache immediately so the UI reflects the change
    // without waiting for Supabase realtime
    try {
      const { useDMStore } = await import('@/stores/useDM')
      const dmStore = useDMStore()
      const messages = dmStore.currentDMMessages
      const msgIndex = messages.findIndex((m: any) => m.id === call.systemMessageId)
      if (msgIndex !== -1) {
        messages[msgIndex] = { ...messages[msgIndex], metadata: newMetadata }
        debug.log('📞 Updated local message cache for call system message')
      }
    } catch {
      // Store not available, realtime will handle it
    }
  }

  // =============================================================================
  // FEDERATED CALL METHODS
  // =============================================================================

  /**
   * Initiate a federated call (to a user on a remote instance)
   * Uses ActivityPub voice extensions instead of Supabase Realtime
   */
  async initiateFederatedCall(
    conversationId: string,
    callerId: string,
    callerFederatedId: string,
    calleeFederatedId: string,
    callType: 'voice' | 'video'
  ): Promise<FederatedCallInfo | null> {
    debug.log('📞 [Federated] Initiating federated call to:', calleeFederatedId)
    
    try {
      // Get LiveKit config from the backend
      const configResponse = await fetch('/api/livekit/config')
      const config = await configResponse.json()
      
      if (!config.enabled || !config.wsUrl) {
        debug.error('❌ LiveKit not configured for federated calls')
        return null
      }
      
      // Generate a room name for this federated call
      const roomName = `federated-dm-${conversationId}-${Date.now()}`
      
      // Get a token for this room
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        debug.error('❌ Not authenticated')
        return null
      }
      
      const tokenResponse = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          roomName,
          roomType: 'dm_call',
        }),
      })
      
      if (!tokenResponse.ok) {
        debug.error('❌ Failed to get LiveKit token')
        return null
      }
      
      // Send federated call invite via ActivityPub
      // This is handled by the federation backend
      const inviteResponse = await fetch('/api/livekit/federated-call/invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          callerFederatedId,
          calleeFederatedId,
          callType,
          conversationId,
          livekitUrl: config.wsUrl,
          roomName,
        }),
      })
      
      if (!inviteResponse.ok) {
        debug.error('❌ Failed to send federated call invite')
        return null
      }
      
      // Track as active federated call
      const timeoutTimer = window.setTimeout(() => {
        this.handleFederatedCallTimeout(conversationId, callerId)
      }, this.CALL_TIMEOUT_MS)
      
      const callInfo: FederatedCallInfo = {
        callerFederatedId,
        calleeFederatedId,
        callerInstanceUrl: config.instanceDomain || window.location.origin,
        livekitUrl: config.wsUrl,
        roomName,
      }
      
      this.setActiveCall(conversationId, {
        conversationId,
        channelId: roomName,
        callType,
        callerId,
        receiverIds: [],
        participants: [callerId],
        allParticipants: [callerId],
        startedAt: new Date(),
        timeoutTimer,
        systemMessageId: null,
        isFederated: true,
        callerFederatedId,
        calleeFederatedId,
        livekitUrl: config.wsUrl,
        roomName,
      })
      
      debug.log('✅ [Federated] Call initiated, waiting for response')
      return callInfo
    } catch (error) {
      debug.error('❌ [Federated] Failed to initiate call:', error)
      return null
    }
  }

  /**
   * Accept a federated call
   */
  async acceptFederatedCall(
    conversationId: string,
    userId: string,
    callerFederatedId: string
  ): Promise<{ token: string; wsUrl: string; roomName: string } | null> {
    debug.log('📞 [Federated] Accepting federated call from:', callerFederatedId)
    
    try {
      const call = this.activeCalls.get(conversationId)
      if (!call || !call.isFederated) {
        debug.error('❌ No federated call found for conversation')
        return null
      }
      
      // Clear timeout
      if (call.timeoutTimer) {
        clearTimeout(call.timeoutTimer)
        call.timeoutTimer = undefined
      }
      
      // Add to participants
      if (!call.participants.includes(userId)) {
        call.participants.push(userId)
      }
      
      // Get federated token from caller's instance
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        debug.error('❌ Not authenticated')
        return null
      }
      
      // Send accept via ActivityPub
      await fetch('/api/livekit/federated-call/accept', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          conversationId,
          callerFederatedId,
        }),
      })
      
      // Return connection info
      return {
        token: '', // Token will be fetched when connecting
        wsUrl: call.livekitUrl || '',
        roomName: call.roomName || '',
      }
    } catch (error) {
      debug.error('❌ [Federated] Failed to accept call:', error)
      return null
    }
  }

  /**
   * Decline a federated call
   */
  async declineFederatedCall(
    conversationId: string,
    userId: string,
    callerFederatedId: string
  ): Promise<void> {
    debug.log('📞 [Federated] Declining federated call from:', callerFederatedId)
    
    try {
      const call = this.activeCalls.get(conversationId)
      if (call?.timeoutTimer) {
        clearTimeout(call.timeoutTimer)
      }
      
      // Send decline via ActivityPub
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        await fetch('/api/livekit/federated-call/reject', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            conversationId,
            callerFederatedId,
          }),
        })
      }
      
      this.deleteActiveCall(conversationId)
    } catch (error) {
      debug.error('❌ [Federated] Failed to decline call:', error)
    }
  }

  /**
   * End a federated call
   */
  async endFederatedCall(
    conversationId: string,
    _userId: string
  ): Promise<void> {
    debug.log('📞 [Federated] Ending federated call')
    
    try {
      const call = this.activeCalls.get(conversationId)
      if (!call?.isFederated) return
      
      if (call.timeoutTimer) {
        clearTimeout(call.timeoutTimer)
      }
      
      // Send end via ActivityPub
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        await fetch('/api/livekit/federated-call/end', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            conversationId,
            otherParticipantFederatedId: call.calleeFederatedId || call.callerFederatedId,
          }),
        })
      }
      
      this.deleteActiveCall(conversationId)
    } catch (error) {
      debug.error('❌ [Federated] Failed to end call:', error)
    }
  }

  /**
   * Handle federated call timeout
   */
  private handleFederatedCallTimeout(conversationId: string, callerId: string): void {
    debug.log('⏰ [Federated] Call timeout for:', conversationId)
    
    const call = this.activeCalls.get(conversationId)
    if (!call?.isFederated) return
    
    // Only timeout if still ringing
    if (call.participants.length === 1) {
      this.deleteActiveCall(conversationId)
      
      // Notify UI of timeout
      const listeners = this.listeners.get(conversationId)
      if (listeners) {
        const signal: CallSignal = {
          type: 'timeout',
          callerId,
          callType: call.callType,
          timestamp: Date.now(),
          conversationId,
          reason: 'timeout',
          isFederated: true,
        }
        listeners.forEach(listener => listener(signal))
      }
    }
  }

  /**
   * Subscribe to incoming federated calls (via Supabase Realtime)
   * The federation backend broadcasts to this channel
   */
  subscribeToFederatedCalls(userId: string, onIncomingCall: (callInfo: {
    callId: string
    callerId: string
    callerName: string
    callerAvatar: string
    callerFederatedId: string
    callType: 'voice' | 'video'
    livekitUrl: string
    roomName: string
    conversationId: string
  }) => void): () => void {
    const channelName = `federated-calls:${userId}`
    debug.log('📡 [Federated] Subscribing to:', channelName)
    
    const channel = supabase.channel(channelName)
    
    channel
      .on('broadcast', { event: 'incoming-call' }, (payload) => {
        debug.log('📞 [Federated] Incoming call:', payload.payload)
        onIncomingCall(payload.payload)
      })
      .on('broadcast', { event: 'call-accepted' }, (payload) => {
        debug.log('📞 [Federated] Call accepted:', payload.payload)
        // Update active call state
        const { callId } = payload.payload
        const call = this.activeCalls.get(callId)
        if (call && call.timeoutTimer) {
          clearTimeout(call.timeoutTimer)
          call.timeoutTimer = undefined
        }
      })
      .on('broadcast', { event: 'call-rejected' }, (payload) => {
        debug.log('📞 [Federated] Call rejected:', payload.payload)
        this.deleteActiveCall(payload.payload.callId)
      })
      .on('broadcast', { event: 'call-ended' }, (payload) => {
        debug.log('📞 [Federated] Call ended:', payload.payload)
        this.deleteActiveCall(payload.payload.callId)
      })
      .subscribe()
    
    return () => {
      channel.unsubscribe()
    }
  }

  /**
   * Check if a call is federated
   */
  isFederatedCall(conversationId: string): boolean {
    return this.activeCalls.get(conversationId)?.isFederated ?? false
  }

  /**
   * Cleanup all channels
   */
  cleanup(): void {
    // Clear all timeout timers
    this.activeCalls.forEach(call => {
      if (call.timeoutTimer) {
        clearTimeout(call.timeoutTimer)
      }
    })
    
    this.channels.forEach(channel => channel.unsubscribe())
    this.channels.clear()
    this.listeners.clear()
    this.activeCalls.clear()
  }
}

// Singleton instance
export const dmCallSignaling = new DMCallSignalingService()

