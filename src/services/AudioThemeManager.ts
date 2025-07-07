import type { AudioTheme, AudioAction, AudioThemeSettings } from '@/types'

/**
 * Audio Theme Manager
 * Handles audio theme management, caching, and playback
 */
export class AudioThemeManager {
  private static instance: AudioThemeManager | null = null
  private audioCache = new Map<string, HTMLAudioElement>()
  private currentTheme: string = 'harmony'
  private volume: number = 0.7
  private themes: Map<string, AudioTheme> = new Map()
  private lastPlayTime = new Map<string, number>()
  private readonly RATE_LIMIT_MS = 100 // Prevent audio spam

  private constructor() {
    this.initializeThemes()
    this.loadSettings()
  }

  public static getInstance(): AudioThemeManager {
    if (!AudioThemeManager.instance) {
      AudioThemeManager.instance = new AudioThemeManager()
    }
    return AudioThemeManager.instance
  }

  /**
   * Initialize available audio themes
   */
  private initializeThemes(): void {
    // Default theme (fallback)
    this.themes.set('default', {
      id: 'default',
      name: 'Default',
      description: 'Clean and minimal sound effects',
      author: 'Harmony Team',
      version: '1.0.0',
      isBuiltIn: true,
      sounds: {
        // Notifications
        mention: '/assets/sounds/default/mention.mp3',
        dm: '/assets/sounds/default/dm.mp3',
        reaction: '/assets/sounds/default/reaction.mp3',
        reply: '/assets/sounds/default/reply.mp3',
        server_invite: '/assets/sounds/default/invite.mp3',
        friend_request: '/assets/sounds/default/request.mp3',
        server_update: '/assets/sounds/default/update.mp3',
        emoji_added: '/assets/sounds/default/new.mp3',
        voice_channel_activity: '/assets/sounds/default/connect.mp3',
        
        // Voice actions
        voice_connect: '/assets/sounds/voice_connect.mp3',
        voice_disconnect: '/assets/sounds/voice_disconnect.mp3',
        mic_on: '/assets/sounds/mic_on.mp3',
        mic_off: '/assets/sounds/mic_off.mp3',
        camera_on: '/assets/sounds/camera_on.mp3',
        camera_off: '/assets/sounds/camera_off.mp3',
        screenshare_on: '/assets/sounds/screenshare_on.mp3',
        screenshare_off: '/assets/sounds/screenshare_off.mp3',
        
        // UI sounds
        ui_click: '/assets/sounds/poi1.mp3',
        ui_hover: '/assets/sounds/bubble1.mp3',
        ui_success: '/assets/sounds/3.mp3',
        ui_error: '/assets/sounds/pirori-wet.mp3',
        ui_notification: '/assets/sounds/n-ea-harmony.mp3'
      }
    })

    // Harmony theme
    this.themes.set('harmony', {
      id: 'harmony',
      name: 'Harmony',
      description: 'Modern and melodic sounds designed for focus',
      author: 'Harmony Team',
      version: '1.0.0',
      isBuiltIn: true,
      sounds: {
        // Notifications
        mention: '/assets/sounds/harmony/mention.mp3',
        dm: '/assets/sounds/default/dm.mp3', // fallback
        reaction: '/assets/sounds/harmony/reaction.mp3',
        reply: '/assets/sounds/default/reply.mp3', // fallback
        server_invite: '/assets/sounds/default/invite.mp3', // fallback
        friend_request: '/assets/sounds/default/request.mp3', // fallback
        server_update: '/assets/sounds/default/update.mp3', // fallback
        emoji_added: '/assets/sounds/default/new.mp3', // fallback
        voice_channel_activity: '/assets/sounds/harmony/voice_connect.mp3',
        
        // Voice actions
        voice_connect: '/assets/sounds/harmony/voice_connect.mp3',
        voice_disconnect: '/assets/sounds/voice_disconnect.mp3', // fallback
        mic_on: '/assets/sounds/harmony/mic_on.mp3',
        mic_off: '/assets/sounds/mic_off.mp3', // fallback
        camera_on: '/assets/sounds/harmony/camera_on.mp3',
        camera_off: '/assets/sounds/harmony/camera_off.mp3',
        screenshare_on: '/assets/sounds/screenshare_on.mp3', // fallback
        screenshare_off: '/assets/sounds/harmony/screenshare_off.mp3',
        
        // UI sounds
        ui_click: '/assets/sounds/poi1.mp3', // fallback
        ui_hover: '/assets/sounds/bubble1.mp3', // fallback
        ui_success: '/assets/sounds/harmony/login.mp3',
        ui_error: '/assets/sounds/pirori-wet.mp3', // fallback
        ui_notification: '/assets/sounds/n-ea-harmony.mp3' // fallback
      }
    })

    // Professional theme (using sounds from discord folder but renamed)
    this.themes.set('professional', {
      id: 'professional',
      name: 'Professional',
      description: 'Subtle and professional audio cues',
      author: 'Harmony Team',
      version: '1.0.0',
      isBuiltIn: true,
      sounds: {
        // Notifications - using defaults for most
        mention: '/assets/sounds/default/mention.mp3',
        dm: '/assets/sounds/default/dm.mp3',
        reaction: '/assets/sounds/default/reaction.mp3',
        reply: '/assets/sounds/default/reply.mp3',
        server_invite: '/assets/sounds/default/invite.mp3',
        friend_request: '/assets/sounds/default/request.mp3',
        server_update: '/assets/sounds/default/update.mp3',
        emoji_added: '/assets/sounds/default/new.mp3',
        voice_channel_activity: '/assets/sounds/discord/voice_connect.mp3',
        
        // Voice actions - using discord folder sounds
        voice_connect: '/assets/sounds/discord/voice_connect.mp3',
        voice_disconnect: '/assets/sounds/discord/voice_disconnect.mp3',
        mic_on: '/assets/sounds/discord/mic_on.mp3', // fallback
        mic_off: '/assets/sounds/discord/mic_off.mp3',
        camera_on: '/assets/sounds/discord/camera_on.mp3',
        camera_off: '/assets/sounds/discord/camera_off.mp3',
        screenshare_on: '/assets/sounds/discord/screenshare_on.mp3',
        screenshare_off: '/assets/sounds/discord/screenshare_off.mp3',
        
        // UI sounds - minimal
        ui_click: '/assets/sounds/poi1.mp3',
        ui_hover: '/assets/sounds/bubble1.mp3',
        ui_success: '/assets/sounds/3.mp3',
        ui_error: '/assets/sounds/pirori-wet.mp3',
        ui_notification: '/assets/sounds/n-ea-harmony.mp3'
      }
    })
  }

  /**
   * Load settings from localStorage
   */
  private loadSettings(): void {
    try {
      const stored = localStorage.getItem('harmony_audio_settings')
      if (stored) {
        const settings: AudioThemeSettings = JSON.parse(stored)
        this.currentTheme = settings.selectedTheme || 'harmony'
        this.volume = settings.volume ?? 0.7
      }
    } catch (error) {
      console.warn('Failed to load audio theme settings:', error)
    }
  }

  /**
   * Save settings to localStorage
   */
  private saveSettings(): void {
    try {
      const settings: AudioThemeSettings = {
        selectedTheme: this.currentTheme,
        volume: this.volume,
        lastUpdated: new Date().toISOString()
      }
      localStorage.setItem('harmony_audio_settings', JSON.stringify(settings))
    } catch (error) {
      console.warn('Failed to save audio theme settings:', error)
    }
  }

  /**
   * Get all available themes
   */
  public getThemes(): AudioTheme[] {
    return Array.from(this.themes.values())
  }

  /**
   * Get current theme
   */
  public getCurrentTheme(): AudioTheme | null {
    return this.themes.get(this.currentTheme) || null
  }

  /**
   * Set current theme
   */
  public setTheme(themeId: string): boolean {
    if (this.themes.has(themeId)) {
      this.currentTheme = themeId
      this.saveSettings()
      // Clear cache when switching themes
      this.audioCache.clear()
      return true
    }
    return false
  }

  /**
   * Get current volume
   */
  public getVolume(): number {
    return this.volume
  }

  /**
   * Set volume (0.0 to 1.0)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    this.saveSettings()
  }

  /**
   * Get sound path for an action with fallback
   */
  private getSoundPath(action: AudioAction): string | null {
    const currentTheme = this.getCurrentTheme()
    const defaultTheme = this.themes.get('default')
    
    // Try current theme first
    if (currentTheme?.sounds[action]) {
      return currentTheme.sounds[action]
    }
    
    // Fallback to default theme
    if (defaultTheme?.sounds[action]) {
      return defaultTheme.sounds[action]
    }
    
    return null
  }

  /**
   * Preload audio file
   */
  private async preloadAudio(path: string): Promise<HTMLAudioElement> {
    if (this.audioCache.has(path)) {
      return this.audioCache.get(path)!
    }

    return new Promise((resolve, reject) => {
      const audio = new Audio()
      audio.preload = 'auto'
      audio.volume = this.volume
      
      audio.addEventListener('canplaythrough', () => {
        this.audioCache.set(path, audio)
        resolve(audio)
      }, { once: true })
      
      audio.addEventListener('error', () => {
        reject(new Error(`Failed to load audio: ${path}`))
      }, { once: true })
      
      audio.src = path
    })
  }

  /**
   * Play audio for a specific action
   */
  public async playAudio(action: AudioAction): Promise<void> {
    // Rate limiting
    const now = Date.now()
    const lastPlay = this.lastPlayTime.get(action) || 0
    if (now - lastPlay < this.RATE_LIMIT_MS) {
      return
    }
    this.lastPlayTime.set(action, now)

    const soundPath = this.getSoundPath(action)
    if (!soundPath) {
      console.warn(`No sound found for action: ${action}`)
      return
    }

    try {
      let audio: HTMLAudioElement

      if (this.audioCache.has(soundPath)) {
        audio = this.audioCache.get(soundPath)!
        // Clone for concurrent playback
        audio = audio.cloneNode() as HTMLAudioElement
      } else {
        audio = await this.preloadAudio(soundPath)
        audio = audio.cloneNode() as HTMLAudioElement
      }

      audio.volume = this.volume
      audio.currentTime = 0
      
      await audio.play()
    } catch (error) {
      console.warn(`Failed to play audio for ${action}:`, error)
    }
  }

  /**
   * Preload sounds for current theme
   */
  public async preloadCurrentTheme(): Promise<void> {
    const theme = this.getCurrentTheme()
    if (!theme) return

    const promises = Object.values(theme.sounds).map(path => {
      if (path && !this.audioCache.has(path)) {
        return this.preloadAudio(path).catch(() => {
          // Ignore preload errors, they'll be handled during playback
        })
      }
    })

    await Promise.allSettled(promises)
  }

  /**
   * Test audio for a specific action
   */
  public testAudio(action: AudioAction): Promise<void> {
    return this.playAudio(action)
  }

  /**
   * Clear audio cache
   */
  public clearCache(): void {
    this.audioCache.clear()
  }

  /**
   * Get cache size for debugging
   */
  public getCacheSize(): number {
    return this.audioCache.size
  }
}

// Export singleton instance
export const audioThemeManager = AudioThemeManager.getInstance()
