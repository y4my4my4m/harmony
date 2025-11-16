/**
 * DM Call Signaling Service
 * Handles call initiation, ringing, accept/decline via Supabase real-time
 * No database needed - pure real-time signaling
 */

import { supabase } from '@/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'

export interface CallSignal {
  type: 'initiate' | 'accept' | 'decline' | 'end' | 'join' | 'leave'
  callerId: string
  callType: 'voice' | 'video'
  timestamp: number
  conversationId: string
}

export interface ActiveCall {
  conversationId: string
  channelId: string // dm-{conversationId}
  callType: 'voice' | 'video'
  callerId: string
  participants: string[] // user IDs currently in call
  startedAt: Date
}

class DMCallSignalingService {
  private channels: Map<string, RealtimeChannel> = new Map()
  private activeCalls: Map<string, ActiveCall> = new Map()
  private listeners: Map<string, Set<(signal: CallSignal) => void>> = new Map()

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
          console.log('📞 Received call signal:', signal)
          
          // Notify all listeners
          const listeners = this.listeners.get(conversationId)
          if (listeners) {
            listeners.forEach(listener => listener(signal))
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
    
    await channel.send({
      type: 'broadcast',
      event: 'call-signal',
      payload: signal
    })
    
    console.log('📤 Sent call signal:', signal)
  }

  /**
   * Initiate a call
   */
  async initiateCall(
    conversationId: string,
    callerId: string,
    callType: 'voice' | 'video'
  ): Promise<void> {
    const signal: CallSignal = {
      type: 'initiate',
      callerId,
      callType,
      timestamp: Date.now(),
      conversationId
    }
    
    // Track active call
    this.activeCalls.set(conversationId, {
      conversationId,
      channelId: `dm-${conversationId}`,
      callType,
      callerId,
      participants: [callerId],
      startedAt: new Date()
    })
    
    await this.sendSignal(conversationId, signal)
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
    
    await this.sendSignal(conversationId, signal)
  }

  /**
   * Decline a call
   */
  async declineCall(
    conversationId: string,
    userId: string
  ): Promise<void> {
    const signal: CallSignal = {
      type: 'decline',
      callerId: userId,
      callType: 'voice', // doesn't matter for decline
      timestamp: Date.now(),
      conversationId
    }
    
    await this.sendSignal(conversationId, signal)
  }

  /**
   * End a call
   */
  async endCall(
    conversationId: string,
    userId: string
  ): Promise<void> {
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
   * Get active call for conversation
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
    this.channels.forEach(channel => channel.unsubscribe())
    this.channels.clear()
    this.listeners.clear()
    this.activeCalls.clear()
  }
}

// Singleton instance
export const dmCallSignaling = new DMCallSignalingService()

