import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { setBaseFavicon } from '@/utils/faviconBadge'

interface InstanceSettings {
  // Instance identity
  domain: string
  instanceName: string
  instanceDescription: string
  /** Branding icon URL used for the document favicon. */
  instanceIcon: string
  
  // Legal / policy URLs
  termsUrl: string
  privacyUrl: string
  
  // Registration
  openRegistration: boolean
  approvalRequired: boolean
  
  // Federation settings (affects UI visibility)
  federationEnabled: boolean
  federationInboundEnabled: boolean
  federationOutboundEnabled: boolean
  
  // Feature flags
  voiceChannelsEnabled: boolean
  fileUploadsEnabled: boolean
  
  // Limits
  maxPostLength: number
  maxMessageLength: number
  maxServerSize: number
  maxCustomEmojisPerServer: number
  maxMediaAttachmentsPerPost: number
  /** imgproxy JPEG/WebP quality (1-100) for custom emoji storage transforms */
  customEmojiTransformQuality: number

  allowCustomEmojisInDisplayNames: boolean

  // GIF / Klipy (picker UI)
  gifAdsEnabled: boolean
  // Optional (recommended) KLIPY attribution watermark on sent GIFs/stickers.
  // The "Search KLIPY" picker placeholder is required attribution and always on.
  gifKlipyWatermarkEnabled: boolean
  // Optional Klipy media types (hidden in picker + no slash command when off).
  gifClipsEnabled: boolean
  gifMemesEnabled: boolean
  gifAiEmojisEnabled: boolean
  // Allow members to generate AI emoji from prompts (Klipy generation API).
  gifAiEmojiGenerationEnabled: boolean

  // Default theme for new/unauthenticated users
  defaultThemeJson: string | null
}

interface InstanceSettingsState {
  settings: InstanceSettings
  isLoaded: boolean
  isLoading: boolean
  lastFetchedAt: number | null
}

const DEFAULT_SETTINGS: InstanceSettings = {
  domain: import.meta.env.VITE_INSTANCE_DOMAIN || window.location.hostname,
  instanceName: import.meta.env.VITE_INSTANCE_NAME || 'Harmony',
  instanceDescription: '',
  instanceIcon: '',
  termsUrl: import.meta.env.VITE_TERMS_URL || '',
  privacyUrl: import.meta.env.VITE_PRIVACY_URL || '',
  openRegistration: true,
  approvalRequired: false,
  federationEnabled: true,
  federationInboundEnabled: true,
  federationOutboundEnabled: true,
  voiceChannelsEnabled: true,
  fileUploadsEnabled: true,
  maxPostLength: 500,
  maxMessageLength: 2000,
  maxServerSize: 1000,
  maxCustomEmojisPerServer: 50,
  maxMediaAttachmentsPerPost: 20,
  allowCustomEmojisInDisplayNames: true,
  gifAdsEnabled: true,
  gifKlipyWatermarkEnabled: true,
  gifClipsEnabled: false,
  gifMemesEnabled: false,
  gifAiEmojisEnabled: false,
  gifAiEmojiGenerationEnabled: false,
  defaultThemeJson: null,
  customEmojiTransformQuality: 80,
}

const CACHE_DURATION = 5 * 60 * 1000

export const useInstanceSettingsStore = defineStore('instanceSettings', {
  state: (): InstanceSettingsState => ({
    settings: { ...DEFAULT_SETTINGS },
    isLoaded: false,
    isLoading: false,
    lastFetchedAt: null,
  }),

  getters: {
    isFederationEnabled: (state): boolean => {
      return state.settings.federationEnabled && 
             (state.settings.federationInboundEnabled || state.settings.federationOutboundEnabled)
    },

    canFollowRemoteUsers: (state): boolean => {
      return state.settings.federationEnabled && state.settings.federationOutboundEnabled
    },

    canReceiveRemoteFollows: (state): boolean => {
      return state.settings.federationEnabled && state.settings.federationInboundEnabled
    },

    /** Optional Klipy media type toggles (default off). */
    gifClipsEnabled: (state): boolean => state.settings.gifClipsEnabled,
    gifMemesEnabled: (state): boolean => state.settings.gifMemesEnabled,
    gifAiEmojisEnabled: (state): boolean => state.settings.gifAiEmojisEnabled,
    gifAiEmojiGenerationEnabled: (state): boolean => state.settings.gifAiEmojiGenerationEnabled,

    isCacheValid: (state): boolean => {
      if (!state.lastFetchedAt) return false
      return Date.now() - state.lastFetchedAt < CACHE_DURATION
    },
  },

  actions: {
    async fetchSettings(force = false): Promise<void> {
      if (!force && this.isCacheValid && this.isLoaded) {
        debug.log('📋 Using cached instance settings')
        return
      }

      if (this.isLoading) return

      this.isLoading = true

      try {
        // RLS on instance_config filters to public_instance_config_keys() for
        // regular users; instance admins see all rows (admin panel).
        const { data, error } = await supabase
          .from('instance_config')
          .select('config_key, config_value')

        if (error) {
          debug.error('Failed to fetch instance settings:', error)
          return
        }

        if (data) {
          this.parseConfigData(data)
        }

        try {
          const { data: fedSettings } = await supabase.rpc('get_public_federation_settings')
          if (fedSettings) {
            this.settings.federationEnabled = fedSettings.federation_enabled ?? true
            if (fedSettings.enable_inbound_federation !== undefined) {
              this.settings.federationInboundEnabled = fedSettings.enable_inbound_federation
            }
            if (fedSettings.enable_outbound_federation !== undefined) {
              this.settings.federationOutboundEnabled = fedSettings.enable_outbound_federation
            }
          }
        } catch (rpcError) {
          debug.warn('Could not fetch federation settings via RPC:', rpcError)
        }

        this.isLoaded = true
        this.lastFetchedAt = Date.now()

        this.applyBranding()

        debug.log('✅ Instance settings loaded:', {
          federationEnabled: this.settings.federationEnabled,
          inbound: this.settings.federationInboundEnabled,
          outbound: this.settings.federationOutboundEnabled,
          termsUrl: this.settings.termsUrl,
          privacyUrl: this.settings.privacyUrl,
        })

      } catch (error) {
        debug.error('Failed to fetch instance settings:', error)
      } finally {
        this.isLoading = false
      }
    },

    parseConfigData(data: Array<{ config_key: string; config_value: any }>) {
      for (const config of data) {
        const value = this.parseValue(config.config_value)

        switch (config.config_key) {
          case 'domain':
            if (value) this.settings.domain = value
            break
          case 'instance_name':
            if (value) this.settings.instanceName = value
            break
          case 'instance_description':
            this.settings.instanceDescription = value || ''
            break
          case 'instance_icon':
            this.settings.instanceIcon = (typeof value === 'string' ? value : '') || ''
            break
          case 'terms_url':
            this.settings.termsUrl = value || ''
            break
          case 'privacy_url':
            this.settings.privacyUrl = value || ''
            break
          case 'open_registration':
            this.settings.openRegistration = value === true || value === 'true'
            break
          case 'approval_required':
            this.settings.approvalRequired = value === true || value === 'true'
            break
          case 'enable_inbound_federation':
            this.settings.federationInboundEnabled = value === true || value === 'true'
            break
          case 'enable_outbound_federation':
            this.settings.federationOutboundEnabled = value === true || value === 'true'
            break
          case 'enable_voice_channels':
            this.settings.voiceChannelsEnabled = value === true || value === 'true'
            break
          case 'allow_file_uploads':
            this.settings.fileUploadsEnabled = value === true || value === 'true'
            break
          case 'max_post_length':
            if (typeof value === 'number') this.settings.maxPostLength = value
            break
          case 'max_message_length':
            if (typeof value === 'number') this.settings.maxMessageLength = value
            break
          case 'max_server_size':
            if (typeof value === 'number') this.settings.maxServerSize = value
            break
          case 'max_custom_emojis_per_server': {
            const num = typeof value === 'number' ? value : parseInt(String(value), 10)
            if (!isNaN(num) && num >= 0) this.settings.maxCustomEmojisPerServer = num
            break
          }
          case 'max_media_attachments_per_post': {
            const num = typeof value === 'number' ? value : parseInt(String(value), 10)
            if (!isNaN(num) && num >= 1) this.settings.maxMediaAttachmentsPerPost = num
            break
          }
          case 'custom_emoji_transform_quality': {
            const num = typeof value === 'number' ? value : parseInt(String(value), 10)
            if (!isNaN(num)) {
              this.settings.customEmojiTransformQuality = Math.min(100, Math.max(1, num))
            }
            break
          }
          case 'allow_custom_emojis_in_display_names':
            this.settings.allowCustomEmojisInDisplayNames = value === true || value === 'true'
            break
          case 'gif_ads_enabled':
            this.settings.gifAdsEnabled = value === true || value === 'true'
            break
          case 'gif_klipy_watermark_enabled':
            this.settings.gifKlipyWatermarkEnabled = value === true || value === 'true'
            break
          case 'gif_clips_enabled':
            this.settings.gifClipsEnabled = value === true || value === 'true'
            break
          case 'gif_memes_enabled':
            this.settings.gifMemesEnabled = value === true || value === 'true'
            break
          case 'gif_ai_emojis_enabled':
            this.settings.gifAiEmojisEnabled = value === true || value === 'true'
            break
          case 'gif_ai_emoji_generation_enabled':
            this.settings.gifAiEmojiGenerationEnabled = value === true || value === 'true'
            break
          case 'default_theme_json':
            if (value && typeof value === 'string') {
              this.settings.defaultThemeJson = value
            } else if (value && typeof value === 'object') {
              this.settings.defaultThemeJson = JSON.stringify(value)
            }
            break
          case 'federation_settings':
            if (value && typeof value === 'object') {
              if (value.federation_enabled !== undefined) {
                this.settings.federationEnabled = value.federation_enabled
              }
            }
            break
        }
      }
    },

    parseValue(val: any): any {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val)
        } catch {
          return val
        }
      }
      return val
    },

    /**
     * Apply instance branding to the document: page title and favicon.
     * The notification store keeps the title in sync with unread counts using
     * the same instance name as its base.
     */
    applyBranding(): void {
      if (typeof document === 'undefined') return
      document.title = this.settings.instanceName || 'Harmony'
      if (this.settings.instanceIcon) {
        setBaseFavicon(this.settings.instanceIcon)
      }
    },

    async refresh(): Promise<void> {
      this.lastFetchedAt = null
      await this.fetchSettings(true)
    },
  },
})

