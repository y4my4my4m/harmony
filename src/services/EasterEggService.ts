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

  initialize(channelId: string, _userId: string): void {
    if (this.channelName === `easter-egg:${channelId}`) {
      return
    }

    this.cleanup()

    this.channelName = `easter-egg:${channelId}`
    debug.log('[EasterEgg] Initializing for channel:', channelId)

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
        debug.log('[EasterEgg] Received activation:', type, 'from', activatorId)
        this.activate(type, activatorId, false)
      })
      .on('broadcast', { event: 'deactivate' }, () => {
        debug.log('[EasterEgg] Received deactivation')
        this.deactivate(false)
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          debug.log('[EasterEgg] Channel subscribed')
        }
      })
  }

  activate(type: EasterEggType, userId: string, broadcast: boolean = true): void {
    if (this.state.isActive && this.state.type === type) {
      return
    }

    this.state = {
      isActive: true,
      type,
      activatedBy: userId,
      activatedAt: Date.now(),
    }

    debug.log('[EasterEgg] Activated:', type)

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

    debug.log('[EasterEgg] Deactivated')

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

  subscribe(listener: (state: EasterEggState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)

    return () => {
      this.listeners.delete(listener)
    }
  }

  getState(): EasterEggState {
    return { ...this.state }
  }

  isActive(): boolean {
    return this.state.isActive
  }

  getActiveType(): EasterEggType | null {
    return this.state.type
  }

  private notifyListeners(): void {
    const state = { ...this.state }
    this.listeners.forEach((listener) => listener(state))
  }

  cleanup(): void {
    if (this.channel) {
      this.channel.unsubscribe()
      this.channel = null
    }
    this.channelName = null
    this.listeners.clear()
    this.deactivate(false)
    debug.log('[EasterEgg] Cleaned up')
  }
}

export const easterEggService = new EasterEggService()

