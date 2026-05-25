import JSZip from 'jszip'
import type { AudioTheme, AudioAction, AudioThemeSettings } from '@/types'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'
import { savePackBlob, getPackBlob, getAllPackBlobs, deletePackBlobs } from '@/utils/audioPackStorage'

const PACK_MAX_BYTES = 10 * 1024 * 1024 // 10MB
const PACK_FORMAT = 'harmony-audio-pack'
const PACK_VERSION = 1

/**
 * Professional Audio Theme Service
 * 
 * A modern, scalable audio theme management system that provides:
 * - Theme management with hot swapping
 * - Intelligent audio caching and preloading
 * - Fallback system for missing sounds
 * - Performance optimized playback
 * - Rate limiting and audio queue management
 * - Professional error handling
 */
export class AudioThemeService {
  private static instance: AudioThemeService | null = null
  
  // Core state
  private audioCache = new Map<string, HTMLAudioElement>()
  private audioQueue = new Map<string, Promise<void>>()
  private settings: AudioThemeSettings = {
    selectedTheme: 'harmony',
    volume: 0.7,
    lastUpdated: new Date().toISOString()
  }
  
  // Performance optimizations
  private lastPlayTime = new Map<string, number>()
  private readonly RATE_LIMIT_MS = 50 // Prevent audio spam
  private readonly MAX_CACHE_SIZE = 100
  private readonly PRELOAD_TIMEOUT = 5000
  
  // Theme registry
  private themes = new Map<string, AudioTheme>()
  private loadedThemes = new Set<string>()
  private pendingPackThemes: Array<{ id: string; name: string; description?: string; author?: string; version?: string; soundsMap: Record<string, string> }> = []
  private packsLoadPromise: Promise<void> | null = null
  
  // Events
  private eventListeners = new Map<string, Array<(...args: any[]) => void>>()

  private static readonly CUSTOM_THEMES_KEY = 'audio_custom_themes'

  private constructor() {
    this.initializeBuiltInThemes()
    this.loadCustomThemes()
    this.loadSettings()
  }

  private loadCustomThemes(): void {
    try {
      const stored = userStorage.getItem(AudioThemeService.CUSTOM_THEMES_KEY)
      if (!stored) return
      const themes = JSON.parse(stored) as Array<AudioTheme & { fromPack?: boolean; soundsMap?: Record<string, string> }>
      if (!Array.isArray(themes)) return
      for (const theme of themes) {
        if (!theme?.id || !theme?.name) continue
        if (theme.fromPack && theme.soundsMap) {
          this.pendingPackThemes.push({
            id: theme.id,
            name: theme.name,
            description: theme.description,
            author: theme.author,
            version: theme.version,
            soundsMap: theme.soundsMap
          })
        } else if (theme?.sounds && typeof theme.sounds === 'object') {
          this.registerTheme({ ...theme, isBuiltIn: false })
        }
      }
    } catch (error) {
      debug.warn('Failed to load custom audio themes:', error)
    }
  }

  /** Hydrate pack themes from IndexedDB and register them. Call before getThemes when loading custom themes. */
  public async ensureCustomPacksLoaded(): Promise<void> {
    if (this.pendingPackThemes.length === 0) return
    const toLoad = [...this.pendingPackThemes]
    this.pendingPackThemes = []
    for (const meta of toLoad) {
      try {
        const blobs = await getAllPackBlobs(meta.id, Object.keys(meta.soundsMap))
        const sounds: Partial<Record<AudioAction, string>> = {}
        for (const [action, filename] of Object.entries(meta.soundsMap)) {
          const blob = blobs[action]
          if (blob) sounds[action as AudioAction] = URL.createObjectURL(blob)
        }
        const bannerBlob = await getPackBlob(meta.id, 'banner')
        const theme: AudioTheme & { soundsMap?: Record<string, string> } = {
          id: meta.id,
          name: meta.name,
          description: meta.description ?? '',
          author: meta.author ?? '',
          version: meta.version ?? '1.0.0',
          isBuiltIn: false,
          sounds,
          ...(bannerBlob && { preview: URL.createObjectURL(bannerBlob) })
        }
        theme.soundsMap = meta.soundsMap
        this.registerTheme(theme)
      } catch (e) {
        debug.warn('Failed to hydrate pack theme:', meta.id, e)
      }
    }
  }

  private saveCustomThemes(): void {
    const custom = Array.from(this.themes.values()).filter(t => !t.isBuiltIn)
    const toStore = custom.map(t => {
      const extended = t as AudioTheme & { soundsMap?: Record<string, string> }
      if (extended.soundsMap) {
        return { id: t.id, name: t.name, description: t.description, author: t.author, version: t.version, isBuiltIn: false, fromPack: true, soundsMap: extended.soundsMap }
      }
      return t
    })
    try {
      userStorage.setItem(AudioThemeService.CUSTOM_THEMES_KEY, JSON.stringify(toStore))
    } catch (error) {
      debug.warn('Failed to save custom audio themes:', error)
    }
  }

  public static getInstance(): AudioThemeService {
    if (!AudioThemeService.instance) {
      AudioThemeService.instance = new AudioThemeService()
    }
    return AudioThemeService.instance
  }

  // =============================================================================
  // THEME MANAGEMENT
  // =============================================================================

  /**
   * Initialize built-in audio themes
   */
  private initializeBuiltInThemes(): void {
    // Default theme (fallback for all missing sounds)
    this.registerTheme({
      id: 'default',
      name: 'Default',
      description: 'Clean and minimal sound effects for focused productivity',
      author: 'Harmony Team',
      version: '1.0.0',
      isBuiltIn: true,
      preview: '/assets/sounds/default/default-preview.webp',
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
        
        // Voice/Video actions
        voice_connect: '/assets/sounds/default/voice_connect.mp3',
        voice_disconnect: '/assets/sounds/default/voice_disconnect.mp3',
        call_incoming: '/assets/sounds/default/call_incoming.mp3',
        call_outgoing: '/assets/sounds/default/call_incoming.mp3',
        call_ended: '/assets/sounds/default/voice_disconnect.mp3',
        mic_on: '/assets/sounds/default/mic_on.mp3',
        mic_off: '/assets/sounds/default/mic_off.mp3',
        deafen_on: '/assets/sounds/default/deafen_on.mp3',
        deafen_off: '/assets/sounds/default/deafen_off.mp3',
        camera_on: '/assets/sounds/default/camera_on.mp3',
        camera_off: '/assets/sounds/default/camera_off.mp3',
        screenshare_on: '/assets/sounds/default/screenshare_on.mp3',
        screenshare_off: '/assets/sounds/default/screenshare_off.mp3',
        
        // UI sounds
        ui_click: '/assets/sounds/default/click.mp3',
        ui_hover: '/assets/sounds/default/hover.mp3',
        ui_success: '/assets/sounds/default/success.mp3',
        ui_error: '/assets/sounds/default/error.mp3',
        ui_notification: '/assets/sounds/default/notification.mp3'
      }
    })

    // Harmony theme - Modern and melodic
    this.registerTheme({
      id: 'harmony',
      name: 'Harmony',
      description: 'Modern and melodic sounds designed for creative focus',
      author: 'Harmony Team',
      version: '1.2.0',
      isBuiltIn: true,
      preview: '/assets/sounds/harmony/harmony-preview.webp',
      sounds: {
        // Notifications with unique harmony sounds
        mention: '/assets/sounds/harmony/mention.mp3',
        dm: '/assets/sounds/harmony/dm.mp3',
        reaction: '/assets/sounds/harmony/reaction.mp3',
        reply: '/assets/sounds/harmony/reply.mp3',
        server_invite: '/assets/sounds/harmony/invite.mp3',
        friend_request: '/assets/sounds/harmony/request.mp3',
        server_update: '/assets/sounds/harmony/update.mp3',
        emoji_added: '/assets/sounds/harmony/emoji.mp3',
        voice_channel_activity: '/assets/sounds/harmony/voice_activity.mp3',
        
        // Voice actions with harmony signature sounds
        voice_connect: '/assets/sounds/harmony/voice_connect.mp3',
        voice_disconnect: '/assets/sounds/harmony/voice_disconnect.mp3',
        call_incoming: '/assets/sounds/harmony/call_incoming.mp3',
        call_outgoing: '/assets/sounds/harmony/call_incoming.mp3',
        call_ended: '/assets/sounds/harmony/voice_disconnect.mp3',
        mic_on: '/assets/sounds/harmony/mic_on.mp3',
        mic_off: '/assets/sounds/harmony/mic_off.mp3',
        deafen_on: '/assets/sounds/harmony/deafen_on.mp3',
        deafen_off: '/assets/sounds/harmony/deafen_off.mp3',
        camera_on: '/assets/sounds/harmony/camera_on.mp3',
        camera_off: '/assets/sounds/harmony/camera_off.mp3',
        screenshare_on: '/assets/sounds/harmony/screenshare_on.mp3',
        screenshare_off: '/assets/sounds/harmony/screenshare_off.mp3',
        
        // UI sounds with melodic tones
        ui_click: '/assets/sounds/harmony/click.mp3',
        ui_hover: '/assets/sounds/harmony/hover.mp3',
        ui_success: '/assets/sounds/harmony/success.mp3',
        ui_error: '/assets/sounds/harmony/error.mp3',
        ui_notification: '/assets/sounds/harmony/notification.mp3'
      }
    })

    // Futuristic theme - Subtle and refined
    this.registerTheme({
      id: 'futuristic',
      name: 'Futuristic',
      description: 'Futuristic audio cues for a modern and engaging experience',
      author: 'Harmony Team',
      version: '1.0.0',
      isBuiltIn: true,
      preview: '/assets/sounds/futuristic/futuristic-preview.webp',
      sounds: {
        // Futuristic notification sounds (using existing assets)
        mention: '/assets/sounds/futuristic/mention.mp3', // Repurposed
        dm: '/assets/sounds/futuristic/dm.mp3',
        reaction: '/assets/sounds/futuristic/reaction.mp3',
        voice_channel_activity: '/assets/sounds/futuristic/voice_connect.mp3',
        
        // Futuristic voice actions
        voice_connect: '/assets/sounds/futuristic/voice_connect.mp3',
        voice_disconnect: '/assets/sounds/futuristic/voice_disconnect.mp3',
        call_incoming: '/assets/sounds/futuristic/call_incoming.mp3',
        call_outgoing: '/assets/sounds/futuristic/call_incoming.mp3',
        call_ended: '/assets/sounds/futuristic/voice_disconnect.mp3',
        mic_on: '/assets/sounds/futuristic/mic_on.mp3',
        mic_off: '/assets/sounds/futuristic/mic_off.mp3',
        deafen_on: '/assets/sounds/futuristic/deafen_on.mp3',
        deafen_off: '/assets/sounds/futuristic/deafen_off.mp3',
        camera_on: '/assets/sounds/futuristic/camera_on.mp3',
        camera_off: '/assets/sounds/futuristic/camera_off.mp3',
        screenshare_on: '/assets/sounds/futuristic/screenshare_on.mp3',
        screenshare_off: '/assets/sounds/futuristic/screenshare_off.mp3',
        
        // Minimal UI sounds
        ui_click: '/assets/sounds/default/click.mp3',
        ui_success: '/assets/sounds/default/success.mp3',
        ui_error: '/assets/sounds/default/error.mp3'
        // Note: Many sounds will fallback to default theme
      }
    })

    // Neo Kobe — pairs with the SDR-001 visual skin. Partial pack: missing
    // actions fall back to the default theme via resolveSoundPath().
    this.registerTheme({
      id: 'neokobe',
      name: 'Neo Kobe',
      description: 'Noir-cyberpunk UI sounds for the SDR-001 skin',
      author: 'Harmony Team',
      version: '1.0.0',
      isBuiltIn: true,
      preview: '/assets/sounds/neokobe/neokobe-preview.webp',
      sounds: {
        dm: '/assets/sounds/neokobe/dm.mp3',
        reaction: '/assets/sounds/neokobe/reaction.mp3',
        reply: '/assets/sounds/neokobe/reply.mp3',
        server_invite: '/assets/sounds/neokobe/invite.mp3',
        mic_off: '/assets/sounds/neokobe/mic_off.mp3',
        camera_on: '/assets/sounds/neokobe/camera_on.mp3',
        screenshare_on: '/assets/sounds/neokobe/screenshare_on.mp3',
        screenshare_off: '/assets/sounds/neokobe/screenshare_off.mp3',
      },
    })
  }

  /**
   * Register a new theme
   */
  public registerTheme(theme: AudioTheme): void {
    this.themes.set(theme.id, theme)
    this.emit('themeRegistered', theme)
  }

  /**
   * Export a full audio theme pack as a ZIP archive.
   * Contains manifest.json (theme metadata + action->filename map), optional banner image, and audio files.
   * Max size 10MB.
   */
  public async exportThemePack(themeId: string): Promise<Blob> {
    const theme = this.themes.get(themeId)
    if (!theme) throw new Error(`Theme '${themeId}' not found`)

    const zip = new JSZip()
    const soundsMap: Record<string, string> = {}
    let bannerFilename: string | undefined

    for (const [action, path] of Object.entries(theme.sounds)) {
      if (!path) continue
      let blob: Blob | null = null
      if (path.startsWith('blob:')) {
        const res = await fetch(path)
        blob = res.ok ? await res.blob() : null
      } else if (path.startsWith('data:')) {
        const res = await fetch(path)
        blob = res.ok ? await res.blob() : null
      } else {
        const url = path.startsWith('/') ? `${window.location.origin}${path}` : path
        const res = await fetch(url)
        blob = res.ok ? await res.blob() : null
      }
      if (blob) {
        const ext = blob.type.includes('ogg') ? 'ogg' : 'mp3'
        const filename = `${action}.${ext}`
        soundsMap[action] = filename
        zip.file(filename, blob)
      }
    }

    if (theme.preview) {
      let bannerBlob: Blob | null = null
      if (theme.preview.startsWith('blob:') || theme.preview.startsWith('data:')) {
        const res = await fetch(theme.preview)
        bannerBlob = res.ok ? await res.blob() : null
      } else {
        const url = theme.preview.startsWith('/') ? `${window.location.origin}${theme.preview}` : theme.preview
        const res = await fetch(url)
        bannerBlob = res.ok ? await res.blob() : null
      }
      if (bannerBlob) {
        const ext = bannerBlob.type.includes('png') ? 'png' : bannerBlob.type.includes('jpeg') || bannerBlob.type.includes('jpg') ? 'jpg' : 'webp'
        bannerFilename = `banner.${ext}`
        zip.file(bannerFilename, bannerBlob)
      }
    }

    const manifest = {
      format: PACK_FORMAT,
      version: PACK_VERSION,
      theme: {
        id: theme.id,
        name: theme.name,
        description: theme.description,
        author: theme.author,
        version: theme.version,
        isBuiltIn: false,
        sounds: soundsMap,
        ...(bannerFilename && { banner: bannerFilename })
      }
    }
    zip.file('manifest.json', JSON.stringify(manifest, null, 2))

    const zipBlob = await zip.generateAsync({ type: 'blob' })
    if (zipBlob.size > PACK_MAX_BYTES) {
      throw new Error(`Pack exceeds 10MB limit (${(zipBlob.size / 1024 / 1024).toFixed(1)}MB)`)
    }
    return zipBlob
  }

  /**
   * Import an audio theme pack from a ZIP archive and register as custom theme.
   */
  public async importThemePack(zipData: ArrayBuffer | Blob): Promise<AudioTheme> {
    const arrayBuffer = zipData instanceof Blob ? await zipData.arrayBuffer() : zipData
    if (arrayBuffer.byteLength > PACK_MAX_BYTES) {
      throw new Error(`Pack exceeds 10MB limit (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB)`)
    }

    const zip = await JSZip.loadAsync(arrayBuffer)
    const manifestFile = zip.file('manifest.json')
    if (!manifestFile) throw new Error('Invalid pack: missing manifest.json')

    const manifestText = await manifestFile.async('string')
    const pack = JSON.parse(manifestText) as { format?: string; version?: number; theme?: AudioTheme & { sounds: Record<string, string>; banner?: string } }
    if (pack.format !== PACK_FORMAT || !pack.theme) {
      throw new Error('Invalid audio pack format. Use an exported Harmony audio theme pack.')
    }
    const meta = pack.theme
    if (!meta.id || !meta.name || !meta.sounds || typeof meta.sounds !== 'object') {
      throw new Error('Invalid theme definition in pack.')
    }

    const id = this.themes.has(meta.id) ? `${meta.id}-${Date.now()}` : meta.id
    const sounds: Partial<Record<AudioAction, string>> = {}
    let preview: string | undefined

    for (const [action, filename] of Object.entries(meta.sounds)) {
      const file = zip.file(filename)
      if (!file) continue
      const blob = await file.async('blob')
      await savePackBlob(id, action, blob)
      sounds[action as AudioAction] = URL.createObjectURL(blob)
    }

    if (meta.banner) {
      const bannerFile = zip.file(meta.banner)
      if (bannerFile) {
        const bannerBlob = await bannerFile.async('blob')
        await savePackBlob(id, 'banner', bannerBlob)
        preview = URL.createObjectURL(bannerBlob)
      }
    }

    const toRegister: AudioTheme = {
      id,
      name: meta.name,
      description: meta.description ?? '',
      author: meta.author ?? '',
      version: meta.version ?? '1.0.0',
      isBuiltIn: false,
      sounds,
      ...(preview && { preview })
    }
    ;(toRegister as AudioTheme & { soundsMap?: Record<string, string> }).soundsMap = meta.sounds

    this.registerTheme(toRegister)
    this.saveCustomThemes()
    this.emit('themeRegistered', toRegister)
    return toRegister
  }

  /**
   * Remove a custom theme by ID
   */
  public async unregisterCustomTheme(themeId: string): Promise<boolean> {
    const theme = this.themes.get(themeId)
    if (!theme || theme.isBuiltIn) return false
    const ext = theme as AudioTheme & { soundsMap?: Record<string, string> }
    if (ext.soundsMap) {
      await deletePackBlobs(themeId)
    }
    this.themes.delete(themeId)
    this.clearCacheForTheme(themeId)
    this.saveCustomThemes()
    return true
  }

  /**
   * Get all available themes
   */
  public getThemes(): AudioTheme[] {
    return Array.from(this.themes.values())
  }

  /**
   * Get current active theme
   */
  public getCurrentTheme(): AudioTheme | null {
    return this.themes.get(this.settings.selectedTheme) || null
  }

  /**
   * Get theme by ID
   */
  public getTheme(themeId: string): AudioTheme | null {
    return this.themes.get(themeId) || null
  }

  // =============================================================================
  // THEME SWITCHING
  // =============================================================================

  /**
   * Set active theme with hot swapping
   */
  public async setTheme(themeId: string): Promise<boolean> {
    const theme = this.themes.get(themeId)
    if (!theme) {
      debug.warn(`Theme '${themeId}' not found`)
      return false
    }

    const previousTheme = this.settings.selectedTheme
    this.settings.selectedTheme = themeId
    this.saveSettings()

    try {
      // Preload new theme sounds
      await this.preloadTheme(themeId)
      
      // Clear old cache to free memory
      this.clearCacheForTheme(previousTheme)
      
      this.emit('themeChanged', { from: previousTheme, to: themeId, theme })
      
      debug.log(`🎵 Switched to audio theme: ${theme.name}`)
      return true
    } catch (error) {
      debug.error(`Failed to switch to theme '${themeId}':`, error)
      // Revert on error
      this.settings.selectedTheme = previousTheme
      this.saveSettings()
      return false
    }
  }

  // =============================================================================
  // AUDIO PLAYBACK
  // =============================================================================

  /**
   * Play audio for a specific action with intelligent fallback
   */
  public async playAudio(action: AudioAction): Promise<void> {
    // Rate limiting per action
    const now = Date.now()
    const lastPlay = this.lastPlayTime.get(action) || 0
    if (now - lastPlay < this.RATE_LIMIT_MS) {
      return
    }
    this.lastPlayTime.set(action, now)

    // Prevent duplicate audio playback
    const queueKey = `${action}-${this.settings.selectedTheme}`
    if (this.audioQueue.has(queueKey)) {
      return
    }

    const playPromise = this.performAudioPlayback(action)
    this.audioQueue.set(queueKey, playPromise)
    
    try {
      await playPromise
    } finally {
      this.audioQueue.delete(queueKey)
    }
  }

  /**
   * Internal audio playback with fallback chain
   */
  private async performAudioPlayback(action: AudioAction): Promise<void> {
    try {
      // Fast path: try cached audio first (stays within user gesture window)
      const soundPath = this.resolveSoundPath(action)
      if (!soundPath) {
        debug.warn(`No sound available for action: ${action}`)
        return
      }

      const cached = this.audioCache.has(soundPath) ? this.audioCache.get(soundPath)! : null
      if (cached) {
        const audioClone = cached.cloneNode() as HTMLAudioElement
        audioClone.volume = this.settings.volume
        await audioClone.play()
        this.emit('audioPlayed', { action, soundPath, theme: this.settings.selectedTheme })
        return
      }

      // Not cached - play directly without waiting for canplaythrough
      // so the browser doesn't expire the user gesture
      const audio = new Audio(soundPath)
      audio.volume = this.settings.volume
      const playPromise = audio.play()

      // Cache in background for next time
      audio.addEventListener('canplaythrough', () => {
        this.addToCache(soundPath, audio)
      }, { once: true })

      await playPromise
      this.emit('audioPlayed', { action, soundPath, theme: this.settings.selectedTheme })
    } catch (error) {
      debug.warn(`Failed to play audio for ${action}:`, error)
      this.emit('audioError', { action, soundPath: '', error })
    }
  }

  /**
   * Resolve the sound file path for an action without loading it
   */
  private resolveSoundPath(action: AudioAction): string | null {
    const currentTheme = this.getCurrentTheme()
    const currentSound = currentTheme?.sounds[action]
    if (currentSound) return currentSound

    const defaultTheme = this.themes.get('default')
    const defaultSound = defaultTheme?.sounds[action]
    if (defaultSound) return defaultSound

    return null
  }

  /**
   * Get the best feedback sound path from a specific theme.
   * Prefers ui_success, then ui_click, then first available sound.
   */
  private resolveThemeFeedbackSoundPath(themeId: string): string | null {
    const theme = this.themes.get(themeId)
    if (!theme?.sounds) return null
    const sounds = theme.sounds
    if (sounds.ui_success) return sounds.ui_success
    if (sounds.ui_click) return sounds.ui_click
    const first = Object.values(sounds)[0]
    return first || null
  }

  /**
   * Play a feedback sound from a specific theme (e.g. when user selects a new pack).
   * Uses ui_success if available, else ui_click, else first sound from that theme.
   */
  public async playThemeFeedbackSound(themeId: string): Promise<void> {
    const soundPath = this.resolveThemeFeedbackSoundPath(themeId)
    if (!soundPath) return
    try {
      const cached = this.audioCache.get(soundPath)
      const audio = cached ? (cached.cloneNode() as HTMLAudioElement) : new Audio(soundPath)
      audio.volume = this.settings.volume
      await audio.play()
      this.emit('audioPlayed', { action: 'ui_success', soundPath, theme: themeId })
    } catch (error) {
      debug.warn(`Failed to play theme feedback for ${themeId}:`, error)
    }
  }

  /**
   * Get audio with smart fallback loading
   */
  private async getAudioWithFallback(action: AudioAction): Promise<HTMLAudioElement | null> {
    // Step 1: Try current theme path
    const currentTheme = this.getCurrentTheme()
    const currentSound = currentTheme?.sounds[action]
    if (currentSound) {
      try {
        return await this.getOrCreateAudio(currentSound)
      } catch (error) {
        debug.warn(`Failed to load ${action} from current theme, trying fallback...`, error)
      }
    }

    // Step 2: Try default theme path as fallback
    const defaultTheme = this.themes.get('default')
    const defaultSound = defaultTheme?.sounds[action]
    if (defaultSound) {
      try {
        return await this.getOrCreateAudio(defaultSound)
      } catch (error) {
        debug.warn(`Failed to load ${action} from default theme`, error)
      }
    }

    return null
  }

  /**
   * Get or create audio element with caching
   */
  private async getOrCreateAudio(path: string): Promise<HTMLAudioElement> {
    if (this.audioCache.has(path)) {
      return this.audioCache.get(path)!
    }

    return this.preloadAudio(path)
  }

  // =============================================================================
  // AUDIO CACHING & PRELOADING
  // =============================================================================

  /**
   * Preload audio file with timeout
   */
  private async preloadAudio(path: string): Promise<HTMLAudioElement> {
    return new Promise((resolve, reject) => {
      const audio = new Audio()
      audio.preload = 'auto'
      audio.volume = this.settings.volume

      const timeoutId = setTimeout(() => {
        reject(new Error(`Audio preload timeout: ${path}`))
      }, this.PRELOAD_TIMEOUT)

      const cleanup = () => {
        clearTimeout(timeoutId)
        audio.removeEventListener('canplaythrough', onLoad)
        audio.removeEventListener('error', onError)
      }

      const onLoad = () => {
        cleanup()
        this.addToCache(path, audio)
        resolve(audio)
      }

      const onError = () => {
        cleanup()
        reject(new Error(`Failed to load audio: ${path}`))
      }

      audio.addEventListener('canplaythrough', onLoad, { once: true })
      audio.addEventListener('error', onError, { once: true })
      
      audio.src = path
    })
  }

  /**
   * Preload entire theme
   */
  public async preloadTheme(themeId: string): Promise<void> {
    const theme = this.themes.get(themeId)
    if (!theme || this.loadedThemes.has(themeId)) {
      return
    }

    debug.log(`🎵 Preloading theme: ${theme.name}`)
    
    const soundPaths = Object.values(theme.sounds).filter(Boolean) as string[]
    const preloadPromises = soundPaths.map(path => 
      this.preloadAudio(path).catch(error => {
        debug.warn(`Failed to preload sound: ${path}`, error)
        // Don't fail the entire theme loading for individual sound failures
      })
    )

    try {
      await Promise.allSettled(preloadPromises)
      this.loadedThemes.add(themeId)
      this.emit('themePreloaded', { themeId, theme })
    } catch (error) {
      debug.warn(`Theme preload completed with some failures: ${themeId}`, error)
    }
  }

  /**
   * Add audio to cache with size management
   */
  private addToCache(path: string, audio: HTMLAudioElement): void {
    // Manage cache size
    if (this.audioCache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.audioCache.keys().next().value
      if (firstKey) {
        this.audioCache.delete(firstKey)
      }
    }

    this.audioCache.set(path, audio)
  }

  /**
   * Clear cache for specific theme
   */
  private clearCacheForTheme(themeId: string): void {
    const theme = this.themes.get(themeId)
    if (!theme) return

    const soundPaths = Object.values(theme.sounds).filter(Boolean) as string[]
    for (const path of soundPaths) {
      this.audioCache.delete(path)
    }

    this.loadedThemes.delete(themeId)
  }

  // =============================================================================
  // SETTINGS MANAGEMENT
  // =============================================================================

  /**
   * Load settings from localStorage
   */
  private loadSettings(): void {
    try {
      const stored = userStorage.getItem('audio_theme_settings')
      if (stored) {
        const settings = JSON.parse(stored)
        this.settings = {
          selectedTheme: settings.selectedTheme || 'harmony',
          volume: typeof settings.volume === 'number' ? settings.volume : 0.7,
          lastUpdated: settings.lastUpdated || new Date().toISOString()
        }
      }
    } catch (error) {
      debug.warn('Failed to load audio theme settings:', error)
    }
  }

  /**
   * Save settings to localStorage
   */
  private saveSettings(): void {
    try {
      this.settings.lastUpdated = new Date().toISOString()
      userStorage.setItem('audio_theme_settings', JSON.stringify(this.settings))
      this.emit('settingsChanged', this.settings)
    } catch (error) {
      debug.warn('Failed to save audio theme settings:', error)
    }
  }

  /**
   * Get current volume (0.0 to 1.0)
   */
  public getVolume(): number {
    return this.settings.volume
  }

  /**
   * Set volume with validation
   */
  public setVolume(volume: number): void {
    this.settings.volume = Math.max(0, Math.min(1, volume))
    this.saveSettings()
  }

  /**
   * Get current settings
   */
  public getSettings(): AudioThemeSettings {
    return { ...this.settings }
  }

  // =============================================================================
  // TESTING & DEBUGGING
  // =============================================================================

  /**
   * Test audio playback for action
   */
  public async testAudio(action: AudioAction): Promise<void> {
    // Bypass rate limiting for testing
    this.lastPlayTime.delete(action)
    return this.playAudio(action)
  }

  /**
   * Get cache information for debugging
   */
  public getCacheInfo(): {
    size: number
    paths: string[]
    loadedThemes: string[]
    maxSize: number
  } {
    return {
      size: this.audioCache.size,
      paths: Array.from(this.audioCache.keys()),
      loadedThemes: Array.from(this.loadedThemes),
      maxSize: this.MAX_CACHE_SIZE
    }
  }

  /**
   * Clear all audio cache
   */
  public clearCache(): void {
    this.audioCache.clear()
    this.loadedThemes.clear()
    this.emit('cacheCleared')
  }

  // =============================================================================
  // EVENT SYSTEM
  // =============================================================================

  /**
   * Add event listener
   */
  public on(event: string, listener: (...args: any[]) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, [])
    }
    this.eventListeners.get(event)!.push(listener)
  }

  /**
   * Remove event listener
   */
  public off(event: string, listener: (...args: any[]) => void): void {
    const listeners = this.eventListeners.get(event)
    if (listeners) {
      const index = listeners.indexOf(listener)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    }
  }

  /**
   * Emit event
   */
  private emit(event: string, ...args: any[]): void {
    const listeners = this.eventListeners.get(event)
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(...args)
        } catch (error) {
          debug.error(`Error in event listener for '${event}':`, error)
        }
      })
    }
  }

  // =============================================================================
  // CLEANUP
  // =============================================================================

  /**
   * Cleanup resources
   */
  public destroy(): void {
    this.clearCache()
    this.eventListeners.clear()
    this.audioQueue.clear()
    this.lastPlayTime.clear()
  }
}

// Export singleton instance
export const audioThemeService = AudioThemeService.getInstance()
