/**
 * Easter Egg Service
 * 
 * Manages easter egg effects and animations
 */

import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'

export type EasterEggType = 'rainbow-party' | 'retro-game' | 'power-up' | 'megaman'

export interface EasterEggState {
  isActive: boolean
  type: EasterEggType | null
  activatedBy: string | null
  activatedAt: number | null
}

class EasterEggService {
  private state: EasterEggState = {
    isActive: false,
    type: null,
    activatedBy: null,
    activatedAt: null,
  }

  private listeners: Set<(state: EasterEggState) => void> = new Set()
  private channel: ReturnType<typeof supabase.channel> | null = null
  private channelName: string | null = null

  /**
   * Initialize easter egg service for a voice channel
   */
  initialize(channelId: string, _userId: string): void {
    if (this.channelName === `easter-egg:${channelId}`) {
      return // Already initialized for this channel
    }

    this.cleanup()

    this.channelName = `easter-egg:${channelId}`
    debug.log('🎮 [EasterEgg] Initializing for channel:', channelId)

    this.channel = supabase.channel(this.channelName, {
      config: {
        broadcast: { self: true },
      },
    })

    this.channel
      .on('broadcast', { event: 'activate' }, (payload) => {
        const { type, userId: activatorId } = payload.payload as {
          type: EasterEggType
          userId: string
        }
        debug.log('🎮 [EasterEgg] Received activation:', type, 'from', activatorId)
        this.activate(type, activatorId, false) // Don't broadcast again
      })
      .on('broadcast', { event: 'deactivate' }, () => {
        debug.log('🎮 [EasterEgg] Received deactivation')
        this.deactivate(false) // Don't broadcast again
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          debug.log('🎮 [EasterEgg] Channel subscribed')
        }
      })
  }

  /**
   * Activate an easter egg
   */
  activate(type: EasterEggType, userId: string, broadcast: boolean = true): void {
    if (this.state.isActive && this.state.type === type) {
      return // Already active
    }

    this.state = {
      isActive: true,
      type,
      activatedBy: userId,
      activatedAt: Date.now(),
    }

    debug.log('🎮 [EasterEgg] Activated:', type)

    this.notifyListeners()

    // Broadcast to other participants
    if (broadcast && this.channel) {
      this.channel.send({
        type: 'broadcast',
        event: 'activate',
        payload: { type, userId },
      })
    }
  }

  /**
   * Deactivate easter egg
   */
  deactivate(broadcast: boolean = true): void {
    if (!this.state.isActive) {
      return
    }

    this.state = {
      isActive: false,
      type: null,
      activatedBy: null,
      activatedAt: null,
    }

    debug.log('🎮 [EasterEgg] Deactivated')

    this.notifyListeners()

    // Broadcast to other participants
    if (broadcast && this.channel) {
      this.channel.send({
        type: 'broadcast',
        event: 'deactivate',
        payload: {},
      })
    }
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: (state: EasterEggState) => void): () => void {
    this.listeners.add(listener)
    // Immediately notify with current state
    listener(this.state)

    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Get current state
   */
  getState(): EasterEggState {
    return { ...this.state }
  }

  /**
   * Check if easter egg is active
   */
  isActive(): boolean {
    return this.state.isActive
  }

  /**
   * Get active easter egg type
   */
  getActiveType(): EasterEggType | null {
    return this.state.type
  }

  private notifyListeners(): void {
    const state = { ...this.state }
    this.listeners.forEach((listener) => listener(state))
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    if (this.channel) {
      this.channel.unsubscribe()
      this.channel = null
    }
    this.channelName = null
    this.listeners.clear() // Clear all listeners to prevent memory leaks
    this.deactivate(false) // Reset state without broadcasting
    debug.log('🎮 [EasterEgg] Cleaned up')
  }
}

// Singleton instance
export const easterEggService = new EasterEggService()

