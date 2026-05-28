import { readFileSync, writeFileSync, existsSync, watch as fsWatch, FSWatcher } from 'fs'
import { parse, stringify } from 'yaml'
import { EventEmitter } from 'events'

export interface ChannelMapping {
  discord: string // Discord channel ID
  harmony: string // Harmony channel ID
  bidirectional: boolean
  name?: string // Human-friendly name
}

export interface BridgeConfig {
  discord: {
    token: string
    guildId: string
  }
  harmony: {
    token: string
    gatewayUrl: string
    apiUrl: string
    serverId: string  // Harmony server UUID for autocomplete
    baseUrl: string   // Public-facing URL (used to derive federation domain for @user@domain mentions)
  }
  channelMappings: ChannelMapping[]
  settings: {
    syncAttachments: boolean
    syncReactions: boolean
    syncEdits: boolean
    syncDeletes: boolean
    mentionTranslation: boolean
  }
}

export class ChannelMapper extends EventEmitter {
  private config: BridgeConfig
  private configPath: string
  private watcher: FSWatcher | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  /** True only while we are saving ourselves - used to suppress the
   *  fs-watch callback that would otherwise re-load the same file we
   *  just wrote and emit a spurious `configReloaded`. */
  private savingSelf = false

  constructor(configPath: string = './config/bridge-config.yml') {
    super()
    this.configPath = configPath
    this.config = this.loadConfig()
  }

  private loadConfig(): BridgeConfig {
    if (!existsSync(this.configPath)) {
      throw new Error(`Config file not found: ${this.configPath}`)
    }

    const fileContent = readFileSync(this.configPath, 'utf8')
    return parse(fileContent) as BridgeConfig
  }

  saveConfig() {
    const yamlContent = stringify(this.config)
    this.savingSelf = true
    try {
      writeFileSync(this.configPath, yamlContent, 'utf8')
    } finally {
      // Suppress the imminent fs-watch callback. fs.watch on most platforms
      // can fire multiple times for a single write; keep the flag set just
      // long enough for those to drain.
      setTimeout(() => { this.savingSelf = false }, 500)
    }
    console.log('✅ Config saved to', this.configPath)
  }

  // ---------------------------------------------------------------------------
  // LIVE RELOAD
  // Watch the YAML on disk so external edits (or our own batch updates) take
  // effect without restarting the bridge. Emits 'configReloaded' with the new
  // config so callers (index.ts) can re-subscribe to channels, etc.
  // ---------------------------------------------------------------------------
  startWatching() {
    if (this.watcher) return
    try {
      this.watcher = fsWatch(this.configPath, (eventType) => {
        if (eventType !== 'change') return
        if (this.savingSelf) return
        // Debounce - editors typically fire two `change` events per save.
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => this.reloadFromDisk(), 250)
      })
      console.log(`👀 Watching ${this.configPath} for changes (live reload)`)
    } catch (err) {
      console.warn(`⚠️  Could not watch config file: ${(err as Error).message}`)
    }
  }

  stopWatching() {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = null
    }
  }

  private reloadFromDisk() {
    try {
      const next = this.loadConfig()
      const prevMappings = this.config.channelMappings
      this.config = next
      console.log(`🔁 Config reloaded (${next.channelMappings.length} mappings)`)
      this.emit('configReloaded', {
        previous: prevMappings,
        current: next.channelMappings,
      })
    } catch (err) {
      console.error(`❌ Failed to reload config: ${(err as Error).message}`)
    }
  }
  
  getConfig(): BridgeConfig {
    return this.config
  }
  
  // =====================================================
  // DISCORD -> HARMONY MAPPING
  // =====================================================
  
  getHarmonyChannel(discordChannelId: string): string | null {
    const mapping = this.config.channelMappings.find(
      m => m.discord === discordChannelId
    )
    return mapping?.harmony || null
  }
  
  /**
   * Returns true when a Discord message in this channel should be mirrored
   * to Harmony.
   *
   * BUGS.md H37: previously this returned `bidirectional ?? false`, which -
   * combined with the same check in `shouldBridgeFromHarmony` - meant
   * `bidirectional: false` disabled BOTH directions. The example config
   * (`bridge-config.example.yml`) documents "If false, only Discord -> Harmony",
   * so Discord→Harmony must remain enabled whenever a mapping exists; only
   * the Harmony→Discord direction is gated by `bidirectional`.
   */
  shouldBridgeFromDiscord(discordChannelId: string): boolean {
    const mapping = this.config.channelMappings.find(
      m => m.discord === discordChannelId
    )
    return Boolean(mapping)
  }
  
  // =====================================================
  // HARMONY -> DISCORD MAPPING
  // =====================================================
  
  getDiscordChannel(harmonyChannelId: string): string | null {
    const mapping = this.config.channelMappings.find(
      m => m.harmony === harmonyChannelId
    )
    return mapping?.discord || null
  }
  
  /**
   * Returns true when a Harmony message in this channel should be mirrored
   * to Discord. Requires the mapping to be explicitly `bidirectional: true`
   * (the default when not specified is `true` for safety with most existing
   * configs that omit the flag).
   */
  shouldBridgeFromHarmony(harmonyChannelId: string): boolean {
    const mapping = this.config.channelMappings.find(
      m => m.harmony === harmonyChannelId
    )
    if (!mapping) return false
    return mapping.bidirectional !== false
  }
  
  // =====================================================
  // MAPPING MANAGEMENT
  // =====================================================
  
  addMapping(discord: string, harmony: string, bidirectional: boolean = true, name?: string) {
    // Check if mapping already exists
    const exists = this.config.channelMappings.some(
      m => m.discord === discord || m.harmony === harmony
    )

    if (exists) {
      throw new Error('Mapping already exists for one or both channels')
    }

    this.config.channelMappings.push({
      discord,
      harmony,
      bidirectional,
      name
    })

    this.saveConfig()
    console.log(`✅ Added mapping: ${discord} <-> ${harmony}`)
  }

  /**
   * Atomically append multiple mappings. Used by `/bridge clone-server` so
   * we do one disk write instead of N. Silently skips entries that would
   * collide with an existing mapping (caller logs them separately).
   *
   * Returns the mappings that were actually added.
   */
  addMappingsBatch(entries: ChannelMapping[]): ChannelMapping[] {
    const taken = new Set<string>([
      ...this.config.channelMappings.map(m => m.discord),
      ...this.config.channelMappings.map(m => m.harmony),
    ])
    const added: ChannelMapping[] = []
    for (const entry of entries) {
      if (taken.has(entry.discord) || taken.has(entry.harmony)) continue
      this.config.channelMappings.push(entry)
      taken.add(entry.discord)
      taken.add(entry.harmony)
      added.push(entry)
    }
    if (added.length > 0) {
      this.saveConfig()
    }
    return added
  }

  removeMapping(discordChannelId: string): boolean {
    const before = this.config.channelMappings.length
    this.config.channelMappings = this.config.channelMappings.filter(
      m => m.discord !== discordChannelId
    )
    const removed = before !== this.config.channelMappings.length
    if (removed) {
      this.saveConfig()
      console.log(`🗑️ Removed mapping for Discord channel ${discordChannelId}`)
    }
    return removed
  }
  
  getAllMappings(): ChannelMapping[] {
    return this.config.channelMappings
  }
  
  // =====================================================
  // SETTINGS
  // =====================================================
  
  getSettings() {
    return this.config.settings
  }
  
  updateSetting(key: keyof BridgeConfig['settings'], value: boolean) {
    this.config.settings[key] = value
    this.saveConfig()
  }
}

