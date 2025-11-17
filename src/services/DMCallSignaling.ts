/**
 * DM Call Signaling Service
 * Handles call initiation, ringing, accept/decline via Supabase real-time
 * No database needed - pure real-time signaling
 */

import { supabase } from '@/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'

export interface CallSignal {
  type: 'initiate' | 'accept' | 'decline' | 'end' | 'join' | 'leave' | 'busy' | 'timeout'
  callerId: string
  callType: 'voice' | 'video'
  timestamp: number
  conversationId: string
  reason?: 'timeout' | 'busy' | 'blocked' | 'dnd' // Decline/busy reasons
}

export interface ActiveCall {
  conversationId: string
  channelId: string // dm-{conversationId}
  callType: 'voice' | 'video'
  callerId: string
  participants: string[] // user IDs currently in call
  startedAt: Date
  timeoutTimer?: number // Timer ID for call timeout
}

class DMCallSignalingService {
  private channels: Map<string, RealtimeChannel> = new Map()
  private activeCalls: Map<string, ActiveCall> = new Map()
  private listeners: Map<string, Set<(signal: CallSignal) => void>> = new Map()
  
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
          console.log('📞 Received call signal:', {
            conversation: conversationId,
            type: signal.type,
            from: signal.callerId,
            callType: signal.callType
          })
          
          // Notify all listeners
          const listeners = this.listeners.get(conversationId)
          if (listeners) {
            console.log(`📞 Notifying ${listeners.size} listener(s)`)
            listeners.forEach(listener => listener(signal))
          } else {
            console.warn('📞 No listeners for conversation:', conversationId)
          }
        })
        .subscribe((status) => {
          console.log(`📡 Call channel ${channelName} status:`, status)
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
   * Send a call signal
   */
  async sendSignal(conversationId: string, signal: CallSignal): Promise<void> {
    const channel = this.channels.get(conversationId)
    
    if (!channel) {
      console.error('❌ No channel for conversation:', conversationId)
      return
    }
    
    console.log('📤 Sending call signal:', {
      conversation: conversationId,
      type: signal.type,
      from: signal.callerId,
      callType: signal.callType
    })
    
    await channel.send({
      type: 'broadcast',
      event: 'call-signal',
      payload: signal
    })
    
    console.log('✅ Call signal sent successfully')
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
    const signal: CallSignal = {
      type: 'initiate',
      callerId,
      callType,
      timestamp: Date.now(),
      conversationId
    }
    
    // Setup timeout timer
    const timeoutTimer = window.setTimeout(() => {
      this.handleCallTimeout(conversationId, callerId)
    }, this.CALL_TIMEOUT_MS)
    
    // Track active call
    this.activeCalls.set(conversationId, {
      conversationId,
      channelId: `dm-${conversationId}`,
      callType,
      callerId,
      participants: [callerId],
      startedAt: new Date(),
      timeoutTimer
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
    console.log(`📤 Sending call signal to user ${userId} on channel ${channelName}`)
    
    const tempChannel = supabase.channel(channelName)
    
    await tempChannel.send({
      type: 'broadcast',
      event: 'incoming-call',
      payload: signal
    })
    
    console.log('✅ Signal sent to user:', userId)
    
    // Unsubscribe temp channel
    await tempChannel.unsubscribe()
  }
  
  /**
   * Handle call timeout (no answer after 30 seconds)
   */
  private async handleCallTimeout(conversationId: string, callerId: string): Promise<void> {
    const call = this.activeCalls.get(conversationId)
    if (!call) {
      console.log('⏰ Timeout fired but call already ended/answered')
      return
    }
    
    // Only timeout if still ringing (only caller in participants)
    if (call.participants.length === 1 && call.participants[0] === callerId) {
      console.log('⏰ Call timeout - no answer after 30 seconds')
      
      // Send timeout signal to all participants
      for (const participantId of call.participants) {
        await this.sendSignalToUser(participantId, {
          type: 'timeout',
          callerId,
          callType: call.callType,
          timestamp: Date.now(),
          conversationId,
          reason: 'timeout'
        })
      }
      
      this.activeCalls.delete(conversationId)
    } else {
      console.log('⏰ Timeout fired but call was answered (has', call.participants.length, 'participants)')
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
      console.log('⏰ Clearing timeout timer - call accepted')
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
    
    // Send accept signal to the caller's user channel
    await this.sendSignalToUser(call.callerId, signal)
    
    console.log('✅ Accept signal sent to caller:', call.callerId)
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
    this.activeCalls.delete(conversationId)
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
    
    const signal: CallSignal = {
      type: 'end',
      callerId: userId,
      callType: 'voice',
      timestamp: Date.now(),
      conversationId
    }
    
    // Remove from active calls
    this.activeCalls.delete(conversationId)
    
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
    
    await this.sendSignal(conversationId, signal)
  }

  /**
   * Leave a call (participant leaves but call continues)
   */
  async leaveCall(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const call = this.activeCalls.get(conversationId)
    if (!call) return
    
    const signal: CallSignal = {
      type: 'leave',
      callerId: userId,
      callType: call.callType,
      timestamp: Date.now(),
      conversationId
    }
    
    // Remove from participants
    call.participants = call.participants.filter(id => id !== userId)
    
    // If no participants left, end call
    if (call.participants.length === 0) {
      this.activeCalls.delete(conversationId)
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

