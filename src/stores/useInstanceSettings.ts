/**
 * Instance Settings Store
 * 
 * Manages instance-level configuration that affects UI behavior:
 * - Federation enabled/disabled (hides federation UI when disabled)
 * - Instance branding
 * - Feature flags
 * 
 * This is separate from AdminService which handles admin-only operations.
 * This store is for PUBLIC instance settings that affect all users.
 */

import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

interface InstanceSettings {
  // Instance identity
  domain: string
  instanceName: string
  instanceDescription: string
  
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
  /** imgproxy JPEG/WebP quality (1–100) for custom emoji storage transforms */
  customEmojiTransformQuality: number

  // Display names
  allowCustomEmojisInDisplayNames: boolean

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
  defaultThemeJson: null,
  customEmojiTransformQuality: 80,
}

// Cache duration: 5 minutes
const CACHE_DURATION = 5 * 60 * 1000

export const useInstanceSettingsStore = defineStore('instanceSettings', {
  state: (): InstanceSettingsState => ({
    settings: { ...DEFAULT_SETTINGS },
    isLoaded: false,
    isLoading: false,
    lastFetchedAt: null,
  }),

  getters: {
    /**
     * Is federation enabled at instance level?
     * When false, hide all federation-related UI
     */
    isFederationEnabled: (state): boolean => {
      return state.settings.federationEnabled && 
             (state.settings.federationInboundEnabled || state.settings.federationOutboundEnabled)
    },

    /**
     * Can users follow remote users?
     */
    canFollowRemoteUsers: (state): boolean => {
      return state.settings.federationEnabled && state.settings.federationOutboundEnabled
    },

    /**
     * Can remote users follow local users?
     */
    canReceiveRemoteFollows: (state): boolean => {
      return state.settings.federationEnabled && state.settings.federationInboundEnabled
    },

    /**
     * Is the settings cache still valid?
     */
    isCacheValid: (state): boolean => {
      if (!state.lastFetchedAt) return false
      return Date.now() - state.lastFetchedAt < CACHE_DURATION
    },
  },

  actions: {
    /**
     * Fetch instance settings from database
     * Called on app initialization
     */
    async fetchSettings(force = false): Promise<void> {
      // Skip if cache is valid and not forcing
      if (!force && this.isCacheValid && this.isLoaded) {
        debug.log('📋 Using cached instance settings')
        return
      }

      if (this.isLoading) return

      this.isLoading = true

      try {
        // Fetch from instance_config table
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

        // Also try to get federation settings from RPC
        try {
          const { data: fedSettings } = await supabase.rpc('get_public_federation_settings')
          if (fedSettings) {
            this.settings.federationEnabled = fedSettings.federation_enabled ?? true
            // Parse nested settings if present
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

    /**
     * Parse config data from instance_config table
     */
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
          case 'default_theme_json':
            if (value && typeof value === 'string') {
              this.settings.defaultThemeJson = value
            } else if (value && typeof value === 'object') {
              this.settings.defaultThemeJson = JSON.stringify(value)
            }
            break
          case 'federation_settings':
            // Handle nested federation_settings object
            if (value && typeof value === 'object') {
              if (value.federation_enabled !== undefined) {
                this.settings.federationEnabled = value.federation_enabled
              }
            }
            break
        }
      }
    },

    /**
     * Parse a config value (may be JSON string or already parsed)
     */
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
     * Clear cache and refetch
     */
    async refresh(): Promise<void> {
      this.lastFetchedAt = null
      await this.fetchSettings(true)
    },
  },
})

