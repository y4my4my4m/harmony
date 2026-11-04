import type { AudioTheme, AudioAction, AudioThemeSettings } from '@/types'
import { isAndroidApp } from '@/services/androidReleaseNotice'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'
import { savePackBlob, getPackBlob, getAllPackBlobs, deletePackBlobs } from '@/utils/audioPackStorage'

const PACK_MAX_BYTES = 10 * 1024 * 1024 // 10MB
const PACK_FORMAT = 'harmony-audio-pack'
const PACK_VERSION = 1
/** Removed built-in theme; migrate stored selections to default. */
const LEGACY_AUDIO_THEME_HARMONY = 'harmony'
const DEFAULT_AUDIO_THEME_ID = 'default'

/** Volume of a new account, 0 to 1. */
export const DEFAULT_AUDIO_VOLUME = 1
/** Stored-schema revision of audio_theme_settings; see migrateAudioThemeSettings. */
export const AUDIO_SETTINGS_VERSION = 2
const V1_DEFAULT_AUDIO_VOLUME = 0.7

/**
 * Upgrades stored audio theme settings in place. Returns true when they changed.
 *
 * v1 -> v2: the default volume moves from 0.7 to 1. Version 1 wrote the volume with every theme
 * change and its Notifications slider showed 70 whatever was stored, so a stored 0.7 is the
 * untouched default and becomes 1. Any other value was set by the user and is kept.
 */
export function migrateAudioThemeSettings(stored: { volume?: unknown; settingsVersion?: unknown }): boolean {
  const version = typeof stored.settingsVersion === 'number' ? stored.settingsVersion : 1
  if (version >= AUDIO_SETTINGS_VERSION) return false
  if (stored.volume === V1_DEFAULT_AUDIO_VOLUME) stored.volume = DEFAULT_AUDIO_VOLUME
  stored.settingsVersion = AUDIO_SETTINGS_VERSION
  return true
}

function normalizeAudioThemeId(themeId: string | undefined | null): string {
  if (!themeId || themeId === LEGACY_AUDIO_THEME_HARMONY) return DEFAULT_AUDIO_THEME_ID
  return themeId
}

/**
 * Alerts. In the Android app the webview plays every sound on the media stream, which the
 * ringer mode does not silence; these follow the ringer instead: silent on vibrate or silent
 * (Do Not Disturb included), a buzz in place of the BUZZ_ACTIONS on vibrate. Feedback sounds
 * (mic, camera, voice join) play as any app's media.
 */
const RINGER_ACTIONS = new Set<AudioAction>([
  'mention', 'dm', 'reaction', 'reply', 'server_invite', 'friend_request', 'server_update',
  'emoji_added', 'voice_channel_activity', 'call_incoming', 'ui_notification',
])
const BUZZ_ACTIONS = new Set<AudioAction>(['mention', 'dm', 'reply', 'call_incoming'])

/**
 * Decoded as soon as a theme loads: the alert sounds and the call ring. Every other sound of
 * the theme is fetched then too and decoded on first use; a default theme decoded whole is
 * 13.8 MB of 48 kHz float samples.
 */
const DECODED_AHEAD = new Set<AudioAction>([
  'mention', 'dm', 'reaction', 'reply', 'server_invite', 'friend_request', 'server_update',
  'emoji_added', 'voice_channel_activity', 'call_incoming', 'ui_notification', 'ui_success', 'ui_error',
])

/** A sound whose decode takes longer than this after it was asked for is dropped, not played late. */
const LATE_SOUND_MS = 1000
/** How long a play waits for a suspended context to resume before giving up. */
const RESUME_WAIT_MS = 250
/** Inputs that count as user activation for the autoplay policy. */
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

/** Every action a generated pack (scripts/sound-packs) renders. */
const GENERATED_PACK_ACTIONS: AudioAction[] = [
  'mention', 'dm', 'reaction', 'reply', 'server_invite', 'friend_request',
  'server_update', 'emoji_added', 'voice_channel_activity',
  'voice_connect', 'voice_disconnect', 'call_incoming', 'call_outgoing', 'call_ended',
  'mic_on', 'mic_off', 'deafen_on', 'deafen_off', 'camera_on', 'camera_off',
  'screenshare_on', 'screenshare_off',
  'ui_click', 'ui_hover', 'ui_success', 'ui_error', 'ui_notification',
]

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
  // Web Audio: sound files are fetched and decoded ahead of use and a play starts a buffer
  // source, with no request. HTMLAudioElement (audioCache) is the path where AudioContext is
  // absent.
  private ctx: AudioContext | null = null
  private ctxFailed = false
  private unlockBound = false
  private soundBytes = new Map<string, Promise<ArrayBuffer | null>>()
  private buffers = new Map<string, AudioBuffer>()
  private decodes = new Map<string, Promise<AudioBuffer | null>>()
  private audioCache = new Map<string, HTMLAudioElement>()
  private audioQueue = new Map<string, Promise<void>>()
  private settings: AudioThemeSettings = {
    selectedTheme: DEFAULT_AUDIO_THEME_ID,
    volume: DEFAULT_AUDIO_VOLUME,
    lastUpdated: new Date().toISOString(),
    settingsVersion: AUDIO_SETTINGS_VERSION,
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
        for (const [action, _filename] of Object.entries(meta.soundsMap)) {
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

  // THEME MANAGEMENT

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
        screenshare_off: '/assets/sounds/default/screenshare_off.mp3',
        
        // Minimal UI sounds
        ui_click: '/assets/sounds/default/click.mp3',
        ui_success: '/assets/sounds/futuristic/success.mp3',
        ui_error: '/assets/sounds/default/error.mp3'
        // Note: Many sounds will fallback to default theme
      }
    })

    // Neo Kobe - pairs with the SDR-001 visual skin (`public/assets/sounds/neokobe/`).
    // Unmapped actions fall back to the default theme via resolveSoundPath().
    const neoKobeBase = '/assets/sounds/neokobe'
    this.registerTheme({
      id: 'neokobe',
      name: 'Neo Kobe',
      description: 'Noir-cyberpunk UI sounds for the SDR-001 skin',
      author: 'Harmony Team',
      version: '1.0.0',
      isBuiltIn: true,
      preview: `${neoKobeBase}/banner.webp`,
      sounds: {
        mention: `${neoKobeBase}/mention.mp3`,
        dm: `${neoKobeBase}/dm.mp3`,
        reaction: `${neoKobeBase}/reaction.mp3`,
        reply: `${neoKobeBase}/reply.mp3`,
        server_invite: `${neoKobeBase}/server_invite.mp3`,
        voice_channel_activity: `${neoKobeBase}/voice_channel_activity.mp3`,
        voice_connect: `${neoKobeBase}/voice_connect.mp3`,
        voice_disconnect: `${neoKobeBase}/voice_disconnect.mp3`,
        call_incoming: `${neoKobeBase}/call_incoming.mp3`,
        call_outgoing: `${neoKobeBase}/call_outgoing.mp3`,
        call_ended: `${neoKobeBase}/call_ended.mp3`,
        mic_on: `${neoKobeBase}/mic_on.mp3`,
        mic_off: `${neoKobeBase}/mic_off.mp3`,
        deafen_on: `${neoKobeBase}/deafen_on.mp3`,
        deafen_off: `${neoKobeBase}/deafen_off.mp3`,
        camera_on: `${neoKobeBase}/camera_on.mp3`,
        camera_off: `${neoKobeBase}/camera_off.mp3`,
        screenshare_on: `${neoKobeBase}/screenshare_on.mp3`,
        screenshare_off: `${neoKobeBase}/screenshare_off.mp3`,
        ui_click: `${neoKobeBase}/ui_click.mp3`,
        ui_success: `${neoKobeBase}/ui_success.mp3`,
        ui_error: `${neoKobeBase}/ui_error.mp3`,
      },
    })

    // Packs generated by scripts/sound-packs/<id>.mjs into
    // public/assets/sounds/<id>/, one file per action. Each pairs with the
    // skin of the same id.
    const generatedPacks = [
      { id: 'skyglass', name: 'Skyglass', description: 'Glass bells, water drops and bubbles for the Skyglass skin' },
      { id: 'lattice', name: 'Lattice', description: 'FM crystal pings, relay ticks and sweeps for the Lattice skin' },
      { id: 'flux', name: 'Flux', description: 'Resonant liquid synth, sub swells and glass sparkle for the Flux skin' },
    ]
    for (const pack of generatedPacks) {
      const base = `/assets/sounds/${pack.id}`
      this.registerTheme({
        ...pack,
        author: 'Harmony Team',
        version: '1.0.0',
        isBuiltIn: true,
        preview: `/assets/skins/${pack.id}-preview.svg`,
        sounds: Object.fromEntries(
          GENERATED_PACK_ACTIONS.map((action) => [action, `${base}/${action}.mp3`]),
        ) as Partial<Record<AudioAction, string>>,
      })
    }
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

    const { default: JSZip } = await import('jszip')
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

    const { default: JSZip } = await import('jszip')
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
    const themeId = normalizeAudioThemeId(this.settings.selectedTheme)
    return this.themes.get(themeId) || null
  }

  /**
   * Get theme by ID
   */
  public getTheme(themeId: string): AudioTheme | null {
    return this.themes.get(themeId) || null
  }

  // THEME SWITCHING

  /**
   * Set active theme with hot swapping
   */
  public async setTheme(themeId: string): Promise<boolean> {
    themeId = normalizeAudioThemeId(themeId)
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
      
      if (previousTheme !== themeId) this.clearCacheForTheme(previousTheme)
      
      this.emit('themeChanged', { from: previousTheme, to: themeId, theme })
      
      debug.log(`Switched to audio theme: ${theme.name}`)
      return true
    } catch (error) {
      debug.error(`Failed to switch to theme '${themeId}':`, error)
      // Revert on error
      this.settings.selectedTheme = previousTheme
      this.saveSettings()
      return false
    }
  }

  // AUDIO PLAYBACK

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
    if (RINGER_ACTIONS.has(action) && isAndroidApp()) {
      const { ringerMode, buzz } = await import('@/services/androidPush')
      const mode = await ringerMode()
      if (mode === 'vibrate' || mode === 'silent') {
        if (mode === 'vibrate' && BUZZ_ACTIONS.has(action)) void buzz()
        return
      }
    }
    const soundPath = this.resolveSoundPath(action)
    if (!soundPath) {
      debug.warn(`No sound available for action: ${action}`)
      return
    }
    if (await this.playPath(soundPath)) {
      this.emit('audioPlayed', { action, soundPath, theme: this.settings.selectedTheme })
    } else {
      this.emit('audioError', { action, soundPath, error: new Error('not played') })
    }
  }

  /** Plays one sound file; false when it could not sound now. */
  private async playPath(soundPath: string): Promise<boolean> {
    const ctx = this.context()
    if (!ctx) return this.playElement(soundPath)
    try {
      if (ctx.state !== 'running') await within(ctx.resume(), RESUME_WAIT_MS)
      if (ctx.state !== 'running') {
        debug.warn(`Audio context ${ctx.state}: no user activation yet`)
        return false
      }
      const buffer = this.buffers.get(soundPath) ?? await within(this.decode(soundPath), LATE_SOUND_MS)
      if (!buffer) return false
      const source = ctx.createBufferSource()
      source.buffer = buffer
      const gain = ctx.createGain()
      gain.gain.value = this.settings.volume
      source.connect(gain)
      gain.connect(ctx.destination)
      source.start()
      return true
    } catch (error) {
      debug.warn(`Failed to play ${soundPath}:`, error)
      return false
    }
  }

  private async playElement(soundPath: string): Promise<boolean> {
    try {
      const cached = this.audioCache.get(soundPath)
      const audio = cached ? (cached.cloneNode() as HTMLAudioElement) : new Audio(soundPath)
      audio.volume = this.settings.volume
      if (!cached) audio.addEventListener('canplaythrough', () => this.addToCache(soundPath, audio), { once: true })
      await audio.play()
      return true
    } catch (error) {
      debug.warn(`Failed to play ${soundPath}:`, error)
      return false
    }
  }

  /**
   * The shared AudioContext, created on first use. A context created before user activation
   * starts suspended; every later pointer, key or touch input resumes it while it is not
   * running (a phone call or the OS can suspend it again).
   */
  private context(): AudioContext | null {
    if (this.ctx || this.ctxFailed) return this.ctx
    const Ctor: typeof AudioContext | undefined = typeof window !== 'undefined'
      ? (window.AudioContext || (window as any).webkitAudioContext)
      : undefined
    if (!Ctor) {
      this.ctxFailed = true
      return null
    }
    try {
      this.ctx = new Ctor()
    } catch (error) {
      debug.warn('AudioContext unavailable:', error)
      this.ctxFailed = true
      return null
    }
    if (!this.unlockBound) {
      this.unlockBound = true
      const resume = () => {
        if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {})
      }
      for (const type of UNLOCK_EVENTS) window.addEventListener(type, resume, { capture: true, passive: true })
    }
    return this.ctx
  }

  /**
   * A sound can start now without waiting on the network or on user activation. Where the page
   * has no AudioContext the element path is tried, and this answers true.
   */
  public canPlayNow(): boolean {
    const ctx = this.context()
    return !ctx || ctx.state === 'running'
  }

  /** Every sound of the theme fetched; the alert sounds decoded. */
  public preloadSounds(themeId: string): Promise<void> {
    const theme = this.themes.get(themeId)
    if (!theme) return Promise.resolve()
    const defaults = this.themes.get(DEFAULT_AUDIO_THEME_ID)?.sounds ?? {}
    const work: Promise<unknown>[] = []
    const seen = new Set<string>()
    for (const action of new Set([...Object.keys(theme.sounds), ...DECODED_AHEAD]) as Set<AudioAction>) {
      const path = theme.sounds[action] || defaults[action]
      if (!path || seen.has(path)) continue
      seen.add(path)
      work.push(DECODED_AHEAD.has(action) ? this.decode(path) : this.fetchBytes(path))
    }
    return Promise.allSettled(work).then(() => undefined)
  }

  private fetchBytes(path: string): Promise<ArrayBuffer | null> {
    let pending = this.soundBytes.get(path)
    if (!pending) {
      pending = fetch(path)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.arrayBuffer()
        })
        .catch((error) => {
          debug.warn(`Failed to fetch sound ${path}:`, error)
          this.soundBytes.delete(path)
          return null
        })
      this.soundBytes.set(path, pending)
    }
    return pending
  }

  private decode(path: string): Promise<AudioBuffer | null> {
    const ready = this.buffers.get(path)
    if (ready) return Promise.resolve(ready)
    const pending = this.decodes.get(path)
    if (pending) return pending
    const ctx = this.context()
    if (!ctx) return Promise.resolve(null)
    const decoding = this.fetchBytes(path)
      // decodeAudioData detaches its argument; the fetched bytes stay whole for a retry.
      .then((bytes) => (bytes ? ctx.decodeAudioData(bytes.slice(0)) : null))
      .then((buffer) => {
        if (buffer) {
          this.buffers.set(path, buffer)
          this.soundBytes.delete(path)
        }
        return buffer
      })
      .catch((error) => {
        debug.warn(`Failed to decode sound ${path}:`, error)
        return null
      })
      .finally(() => this.decodes.delete(path))
    this.decodes.set(path, decoding)
    return decoding
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
    if (await this.playPath(soundPath)) {
      this.emit('audioPlayed', { action: 'ui_success', soundPath, theme: themeId })
    } else {
      debug.warn(`Failed to play theme feedback for ${themeId}`)
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

  // AUDIO CACHING & PRELOADING

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

    debug.log(`Preloading theme: ${theme.name}`)

    if (this.context()) {
      await this.preloadSounds(themeId)
    } else {
      const soundPaths = Object.values(theme.sounds).filter(Boolean) as string[]
      await Promise.allSettled(soundPaths.map(path =>
        this.preloadAudio(path).catch(error => {
          debug.warn(`Failed to preload sound: ${path}`, error)
        })
      ))
    }
    this.loadedThemes.add(themeId)
    this.emit('themePreloaded', { themeId, theme })
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

    // Paths the current theme or the default fallback still play stay loaded.
    const kept = new Set<string>([
      ...Object.values(this.getCurrentTheme()?.sounds ?? {}),
      ...Object.values(this.themes.get(DEFAULT_AUDIO_THEME_ID)?.sounds ?? {}),
    ].filter(Boolean) as string[])
    const soundPaths = Object.values(theme.sounds).filter(Boolean) as string[]
    for (const path of soundPaths) {
      if (kept.has(path) && themeId !== this.settings.selectedTheme) continue
      this.audioCache.delete(path)
      this.buffers.delete(path)
      this.soundBytes.delete(path)
    }

    this.loadedThemes.delete(themeId)
  }

  // SETTINGS MANAGEMENT

  /**
   * Load settings from localStorage
   */
  private loadSettings(): void {
    try {
      const stored = userStorage.getItem('audio_theme_settings')
      if (stored) {
        const settings = JSON.parse(stored)
        const migrated = migrateAudioThemeSettings(settings)
        this.settings = {
          selectedTheme: normalizeAudioThemeId(settings.selectedTheme),
          volume: typeof settings.volume === 'number' ? Math.max(0, Math.min(1, settings.volume)) : DEFAULT_AUDIO_VOLUME,
          lastUpdated: settings.lastUpdated || new Date().toISOString(),
          settingsVersion: AUDIO_SETTINGS_VERSION,
        }
        if (migrated || settings.selectedTheme === LEGACY_AUDIO_THEME_HARMONY) {
          this.saveSettings()
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

  // TESTING & DEBUGGING

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
      size: this.buffers.size + this.audioCache.size,
      paths: [...this.buffers.keys(), ...this.audioCache.keys()],
      loadedThemes: Array.from(this.loadedThemes),
      maxSize: this.MAX_CACHE_SIZE
    }
  }

  /**
   * Clear all audio cache
   */
  public clearCache(): void {
    this.audioCache.clear()
    this.buffers.clear()
    this.soundBytes.clear()
    this.loadedThemes.clear()
    this.emit('cacheCleared')
  }

  // EVENT SYSTEM

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

  // CLEANUP

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
