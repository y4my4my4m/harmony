/**
 * DM Call Signaling Service
 *
 * Call membership is derived from Supabase Realtime *presence* on the
 * per-conversation channel: participants track themselves while connected to
 * the call's voice room, so a refresh/crash drops them automatically and
 * every client converges on the true participant set (no ghost "Join Call").
 * Broadcasts are only used for transient UX: ringing, accept/decline/cancel.
 *
 * Supports federated calls via ActivityPub voice extensions (no presence -
 * the remote party is on another instance).
 */

import { ref } from 'vue'
import { apiUrl } from '@/services/instanceConfig';
import { supabase } from '@/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { authContextService } from './AuthContextService'
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
  participants: string[] // user IDs currently in call (presence-derived)
  allParticipants: string[] // everyone who ever joined (for the ended message)
  startedAt: Date
  ringing: boolean // still waiting for the first answer
  timeoutTimer?: number // Timer ID for call timeout
  systemMessageId: string | null // DB message ID for the call system message
  // Federated call fields
  isFederated?: boolean
  callerFederatedId?: string
  calleeFederatedId?: string
  livekitUrl?: string
  roomName?: string
}

/** Presence payload tracked by each participant while connected to the call */
interface CallPresenceMeta {
  callType: 'voice' | 'video'
  joinedAt: string
  isCaller: boolean
  systemMessageId: string | null
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
  private channelSetup: Map<string, Promise<RealtimeChannel>> = new Map()
  private activeCalls: Map<string, ActiveCall> = new Map()
  private listeners: Map<string, Set<(signal: CallSignal) => void>> = new Map()
  // Presence meta we're currently tracking, per conversation (set while in the call)
  private trackedPresence: Map<string, CallPresenceMeta> = new Map()
  // Debounce for "presence went empty -> call over" so a reconnect blip doesn't end a live call
  private emptyGraceTimers: Map<string, number> = new Map()
  // Callee-side watchdogs: a ringing call whose caller vanished must not ring forever
  private ringWatchdogs: Map<string, number> = new Map()

  // Reactive counter so Vue computeds that read call state re-evaluate on changes.
  // Components should read callStateVersion.value inside their computed to track changes.
  public callStateVersion = ref(0)
  private bumpVersion() { this.callStateVersion.value++ }

  private setActiveCall(conversationId: string, call: ActiveCall) {
    this.activeCalls.set(conversationId, call)
    this.bumpVersion()
  }

  private deleteActiveCall(conversationId: string) {
    this.clearRingWatchdog(conversationId)
    this.activeCalls.delete(conversationId)
    this.bumpVersion()
  }

  private readonly CALL_TIMEOUT_MS = 30000
  // Callers get CALL_TIMEOUT_MS to cancel a no-answer ring themselves; if their
  // client died we clean up shortly after that deadline
  private readonly RING_WATCHDOG_MS = 45000
  private readonly EMPTY_CALL_GRACE_MS = 5000

  // CHANNEL LIFECYCLE
  // One channel per conversation, shared by signal listeners (DMHeader) and
  // presence tracking (while in the call). Released when neither needs it.

  private ensureChannel(conversationId: string): Promise<RealtimeChannel> {
    let setup = this.channelSetup.get(conversationId)
    if (!setup) {
      setup = this.createChannel(conversationId).catch(error => {
        this.channelSetup.delete(conversationId)
        throw error
      })
      this.channelSetup.set(conversationId, setup)
    }
    return setup
  }

  private async createChannel(conversationId: string): Promise<RealtimeChannel> {
    // Presence keys must be profile ids - that's what the rest of the call
    // code uses for participant identity
    const profileId = await authContextService.getCurrentProfileId().catch(() => null)

    const channel = supabase.channel(`dm-call:${conversationId}`, {
      config: { presence: { key: profileId ?? `anon-${Date.now()}` } }
    })

    channel
      .on('broadcast', { event: 'call-signal' }, (payload) => {
        const signal = payload.payload as CallSignal
        debug.log('📞 Received call signal:', {
          conversation: conversationId,
          type: signal.type,
          from: signal.callerId,
          callType: signal.callType
        })
        this.listeners.get(conversationId)?.forEach(listener => listener(signal))
      })
      .on('presence', { event: 'sync' }, () => {
        this.syncFromPresence(conversationId)
      })

    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status) => {
        debug.log(`📡 Call channel dm-call:${conversationId} status:`, status)
        if (status === 'SUBSCRIBED') resolve()
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(`Channel ${status}`))
      })
    })

    this.channels.set(conversationId, channel)

    // track() may have been requested while the channel was still connecting
    const pendingMeta = this.trackedPresence.get(conversationId)
    if (pendingMeta) {
      await channel.track(pendingMeta)
    }

    return channel
  }

  private releaseChannelIfUnused(conversationId: string): void {
    const hasListeners = (this.listeners.get(conversationId)?.size ?? 0) > 0
    if (hasListeners || this.trackedPresence.has(conversationId)) return

    const channel = this.channels.get(conversationId)
    if (channel) {
      channel.unsubscribe()
    }
    this.channels.delete(conversationId)
    this.channelSetup.delete(conversationId)

    const graceTimer = this.emptyGraceTimers.get(conversationId)
    if (graceTimer) {
      clearTimeout(graceTimer)
      this.emptyGraceTimers.delete(conversationId)
    }
  }

  /**
   * Subscribe to call signals for a conversation
   */
  subscribeToConversation(conversationId: string, onSignal: (signal: CallSignal) => void): () => void {
    if (!this.listeners.has(conversationId)) {
      this.listeners.set(conversationId, new Set())
    }
    this.listeners.get(conversationId)!.add(onSignal)

    this.ensureChannel(conversationId).catch(error => {
      debug.error('📞 Failed to open call channel:', conversationId, error)
    })

    return () => {
      const listeners = this.listeners.get(conversationId)
      if (listeners) {
        listeners.delete(onSignal)
        if (listeners.size === 0) {
          this.listeners.delete(conversationId)
          this.releaseChannelIfUnused(conversationId)
        }
      }
    }
  }

  // PRESENCE

  /**
   * Announce ourselves as an active call participant. Called when the voice
   * connection for the DM is established; presence auto-expires when the
   * socket dies (refresh, crash), which is what keeps call state truthful.
   */
  async trackCallPresence(conversationId: string, meta: Omit<CallPresenceMeta, 'joinedAt'>): Promise<void> {
    const fullMeta: CallPresenceMeta = { ...meta, joinedAt: new Date().toISOString() }
    this.trackedPresence.set(conversationId, fullMeta)

    try {
      const channel = await this.ensureChannel(conversationId)
      await channel.track(fullMeta)
      debug.log('📞 Tracking call presence for conversation:', conversationId)
    } catch (error) {
      debug.error('📞 Failed to track call presence:', error)
    }
  }

  async untrackCallPresence(conversationId: string): Promise<void> {
    if (!this.trackedPresence.delete(conversationId)) return

    const channel = this.channels.get(conversationId)
    if (channel) {
      try {
        await channel.untrack()
      } catch (error) {
        debug.warn('📞 Failed to untrack call presence:', error)
      }
    }
    this.releaseChannelIfUnused(conversationId)
  }

  /**
   * Reconcile local call state with the channel's presence set - the source
   * of truth for who is actually connected to the call.
   */
  private syncFromPresence(conversationId: string): void {
    const channel = this.channels.get(conversationId)
    if (!channel) return

    const call = this.activeCalls.get(conversationId)
    if (call?.isFederated) return

    const state = channel.presenceState<CallPresenceMeta>()
    const userIds = Object.keys(state)

    if (userIds.length > 0) {
      const graceTimer = this.emptyGraceTimers.get(conversationId)
      if (graceTimer) {
        clearTimeout(graceTimer)
        this.emptyGraceTimers.delete(conversationId)
      }

      const metas = userIds.map(id => ({ id, meta: state[id][0] }))

      if (!call) {
        // Ongoing call discovered (opened the DM late, or after a refresh)
        const earliest = metas.reduce((a, b) => (a.meta.joinedAt <= b.meta.joinedAt ? a : b))
        const caller = metas.find(m => m.meta.isCaller) ?? earliest
        this.setActiveCall(conversationId, {
          conversationId,
          channelId: `dm-${conversationId}`,
          callType: metas.some(m => m.meta.callType === 'video') ? 'video' : 'voice',
          callerId: caller.id,
          receiverIds: [],
          participants: userIds,
          allParticipants: [...userIds],
          startedAt: new Date(earliest.meta.joinedAt),
          ringing: false,
          systemMessageId: metas.find(m => m.meta.systemMessageId)?.meta.systemMessageId ?? null,
        })
        debug.log('📞 Discovered ongoing call via presence:', conversationId, userIds)
        return
      }

      call.participants = userIds
      for (const id of userIds) {
        if (!call.allParticipants.includes(id)) call.allParticipants.push(id)
      }
      if (!call.systemMessageId) {
        call.systemMessageId = metas.find(m => m.meta.systemMessageId)?.meta.systemMessageId ?? null
      }
      if (call.ringing && userIds.some(id => id !== call.callerId)) {
        call.ringing = false
        if (call.timeoutTimer) {
          clearTimeout(call.timeoutTimer)
          call.timeoutTimer = undefined
        }
      }
      this.clearRingWatchdog(conversationId)
      this.bumpVersion()
      return
    }

    // Presence is empty. A ringing call legitimately has no presence on the
    // callee side yet; otherwise the call is over once the grace period
    // confirms nobody reconnects.
    if (!call || call.ringing) return
    if (this.emptyGraceTimers.has(conversationId)) return

    const timer = window.setTimeout(() => {
      this.emptyGraceTimers.delete(conversationId)
      const current = this.activeCalls.get(conversationId)
      const currentChannel = this.channels.get(conversationId)
      const stillEmpty = !currentChannel || Object.keys(currentChannel.presenceState()).length === 0
      if (current && !current.ringing && stillEmpty) {
        debug.log('📞 Call presence empty - ending call:', conversationId)
        void this.finalizeCallMessage(current)
        this.deleteActiveCall(conversationId)
      }
    }, this.EMPTY_CALL_GRACE_MS)
    this.emptyGraceTimers.set(conversationId, timer)
  }

  private clearRingWatchdog(conversationId: string): void {
    const watchdog = this.ringWatchdogs.get(conversationId)
    if (watchdog) {
      clearTimeout(watchdog)
      this.ringWatchdogs.delete(conversationId)
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
    
    const timeoutTimer = window.setTimeout(() => {
      this.handleCallTimeout(conversationId, callerId)
    }, this.CALL_TIMEOUT_MS)
    
    this.setActiveCall(conversationId, {
      conversationId,
      channelId: `dm-${conversationId}`,
      callType,
      callerId,
      receiverIds,
      participants: [callerId],
      allParticipants: [callerId],
      startedAt,
      ringing: true,
      timeoutTimer,
      systemMessageId,
    })

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

    if (call.ringing) {
      debug.log('⏰ Call timeout - no answer after 30 seconds')
      
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
      debug.log('⏰ Timeout fired but call was answered')
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

    if (call.timeoutTimer) {
      debug.log('⏰ Clearing timeout timer - call accepted')
      clearTimeout(call.timeoutTimer)
      call.timeoutTimer = undefined
    }
    call.ringing = false
    this.clearRingWatchdog(conversationId)

    const signal: CallSignal = {
      type: 'accept',
      callerId: userId,
      callType: call.callType,
      timestamp: Date.now(),
      conversationId
    }

    if (!call.participants.includes(userId)) {
      call.participants.push(userId)
    }
    if (!call.allParticipants.includes(userId)) {
      call.allParticipants.push(userId)
    }
    this.bumpVersion()

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

    if (call?.timeoutTimer) {
      clearTimeout(call.timeoutTimer)
    }

    await this.untrackCallPresence(conversationId)

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

    call.ringing = false
    if (call.timeoutTimer) {
      clearTimeout(call.timeoutTimer)
      call.timeoutTimer = undefined
    }
    if (!call.participants.includes(userId)) {
      call.participants.push(userId)
    }
    if (!call.allParticipants.includes(userId)) {
      call.allParticipants.push(userId)
    }
    this.bumpVersion()

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
    await this.untrackCallPresence(conversationId)

    const call = this.activeCalls.get(conversationId)
    if (!call) return

    if (call.timeoutTimer) {
      clearTimeout(call.timeoutTimer)
      call.timeoutTimer = undefined
    }

    const isCallerCancel = call.ringing && userId === call.callerId

    call.participants = call.participants.filter(id => id !== userId)

    if (isCallerCancel) {
      // Caller hung up before anyone answered - cancel the ring everywhere
      await this.finalizeCallMessage(call)
      this.deleteActiveCall(conversationId)

      const endSignal: CallSignal = {
        type: 'end',
        callerId: userId,
        callType: call.callType,
        timestamp: Date.now(),
        conversationId
      }

      await this.sendSignal(conversationId, endSignal)

      // Notify each receiver on their user channel so GlobalDMCallListener
      // dismisses the incoming call modal
      for (const receiverId of call.receiverIds) {
        await this.sendSignalToUser(receiverId, endSignal)
      }
      return
    }

    const signal: CallSignal = {
      type: 'leave',
      callerId: userId,
      callType: call.callType,
      timestamp: Date.now(),
      conversationId
    }

    if (call.participants.length === 0) {
      // We were the last one in - the call is over
      await this.finalizeCallMessage(call)
      this.deleteActiveCall(conversationId)
    } else {
      // Others remain: the call continues without us (presence keeps our
      // local view in sync; whoever leaves last finalizes the message)
      this.bumpVersion()
    }

    await this.sendSignal(conversationId, signal)
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
      ringing: true,
      systemMessageId: systemMessageId ?? null,
    })

    // If the caller's client dies mid-ring we never get a cancel/timeout
    // signal - drop the stale ringing call after the deadline passes
    this.clearRingWatchdog(conversationId)
    const watchdog = window.setTimeout(() => {
      this.ringWatchdogs.delete(conversationId)
      const call = this.activeCalls.get(conversationId)
      if (call?.ringing) {
        debug.log('⏰ Ring watchdog expired - clearing stale call:', conversationId)
        this.deleteActiveCall(conversationId)
      }
    }, this.RING_WATCHDOG_MS)
    this.ringWatchdogs.set(conversationId, watchdog)

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
          call.ringing = false
          if (call.timeoutTimer) {
            clearTimeout(call.timeoutTimer)
            call.timeoutTimer = undefined
          }
          this.clearRingWatchdog(signal.conversationId)
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
        // Presence is authoritative for membership; the broadcast just makes
        // the UI react instantly. Never delete the call here - if it's truly
        // over, the empty-presence path ends it.
        if (call) {
          call.participants = call.participants.filter(id => id !== signal.callerId)
          this.bumpVersion()
        }
        break
      case 'end':
      case 'timeout':
        this.deleteActiveCall(signal.conversationId)
        break
    }
  }

  /**
   * Update the system message to show the call has ended with duration info.
   * Uses the finalize_dm_call_message RPC (SECURITY DEFINER) so any
   * conversation participant can finalize; falls back to a direct update
   * (owner-only under RLS) when the RPC isn't deployed yet.
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
      const { error: rpcError } = await supabase.rpc('finalize_dm_call_message', {
        p_message_id: call.systemMessageId,
        p_ended_at: endedAt.toISOString(),
        p_duration_seconds: durationSeconds,
        p_participants: call.allParticipants,
      })

      if (rpcError) {
        debug.warn('finalize_dm_call_message RPC unavailable, falling back to direct update:', rpcError.message)
        await supabase.from('messages').update({
          metadata: newMetadata
        }).eq('id', call.systemMessageId)
      }

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
      // cache update is best-effort
    }
  }

  // FEDERATED CALL METHODS

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
      const configResponse = await fetch(apiUrl('/api/livekit/config'))
      const config = await configResponse.json()
      
      if (!config.enabled || !config.wsUrl) {
        debug.error('❌ LiveKit not configured for federated calls')
        return null
      }
      
      const roomName = `federated-dm-${conversationId}-${Date.now()}`
      
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        debug.error('❌ Not authenticated')
        return null
      }
      
      const tokenResponse = await fetch(apiUrl('/api/livekit/token'), {
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
      const inviteResponse = await fetch(apiUrl('/api/livekit/federated-call/invite'), {
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
        ringing: true,
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
      
      if (call.timeoutTimer) {
        clearTimeout(call.timeoutTimer)
        call.timeoutTimer = undefined
      }
      call.ringing = false

      if (!call.participants.includes(userId)) {
        call.participants.push(userId)
      }
      this.bumpVersion()

      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        debug.error('❌ Not authenticated')
        return null
      }
      
      await fetch(apiUrl('/api/livekit/federated-call/accept'), {
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
      
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        await fetch(apiUrl('/api/livekit/federated-call/reject'), {
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
      
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        await fetch(apiUrl('/api/livekit/federated-call/end'), {
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

    if (call.ringing) {
      this.deleteActiveCall(conversationId)
      
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
    this.activeCalls.forEach(call => {
      if (call.timeoutTimer) {
        clearTimeout(call.timeoutTimer)
      }
    })
    this.emptyGraceTimers.forEach(timer => clearTimeout(timer))
    this.ringWatchdogs.forEach(timer => clearTimeout(timer))

    this.channels.forEach(channel => channel.unsubscribe())
    this.channels.clear()
    this.channelSetup.clear()
    this.listeners.clear()
    this.activeCalls.clear()
    this.trackedPresence.clear()
    this.emptyGraceTimers.clear()
    this.ringWatchdogs.clear()
  }
}

// Singleton instance
export const dmCallSignaling = new DMCallSignalingService()

