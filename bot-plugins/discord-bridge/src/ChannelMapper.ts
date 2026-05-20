import { readFileSync, writeFileSync, existsSync } from 'fs'
import { parse, stringify } from 'yaml'

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

export class ChannelMapper {
  private config: BridgeConfig
  private configPath: string
  
  constructor(configPath: string = './config/bridge-config.yml') {
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
    writeFileSync(this.configPath, yamlContent, 'utf8')
    console.log('✅ Config saved to', this.configPath)
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
   * BUGS.md H37: previously this returned `bidirectional ?? false`, which —
   * combined with the same check in `shouldBridgeFromHarmony` — meant
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
  
  removeMapping(discordChannelId: string) {
    this.config.channelMappings = this.config.channelMappings.filter(
      m => m.discord !== discordChannelId
    )
    this.saveConfig()
    console.log(`🗑️ Removed mapping for Discord channel ${discordChannelId}`)
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

