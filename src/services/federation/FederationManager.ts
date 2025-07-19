/**
 * FederationManager - Central coordinator for federation
 * 
 * Provides unified federation control and coordination between
 * incoming and outgoing handlers. Manages federation settings
 * at instance and user levels.
 * 
 * Features:
 * - Instance-level federation toggle
 * - User-level federation preferences
 * - Federation status monitoring
 * - Clean error handling
 * - Performance metrics
 */

import { supabase } from '@/supabase'
import { createIncomingHandler, type IncomingHandler } from './IncomingHandler'
import { createOutgoingHandler, type OutgoingHandler } from './OutgoingHandler'
import type { ActivityPubActivity } from '@/types'

export interface FederationConfig {
  instanceEnabled: boolean
  instanceDomain: string
  instanceUrl: string
  userPreferences?: {
    federationEnabled: boolean
    autoAcceptFollows: boolean
    publicTimeline: boolean
  }
}

export interface FederationStatus {
  enabled: boolean
  health: 'healthy' | 'degraded' | 'offline'
  lastActivity?: Date
  queueSize?: number
  failureRate?: number
}

export interface ProcessingResult {
  success: boolean
  processed: number
  failed: number
  errors: string[]
}

export class FederationManager {
  private static instance: FederationManager
  private incomingHandler: IncomingHandler | null = null
  private outgoingHandler: OutgoingHandler | null = null
  private config: FederationConfig | null = null
  private initialized = false
  
  static getInstance(): FederationManager {
    if (!FederationManager.instance) {
      FederationManager.instance = new FederationManager()
    }
    return FederationManager.instance
  }
  
  /**
   * Initialize federation manager
   */
  async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) {
      return { success: true }
    }
    
    try {
      console.log('🌐 FederationManager: Initializing...')
      
      // Load federation configuration
      const configResult = await this.loadConfig()
      if (!configResult.success) {
        return { success: false, error: configResult.error }
      }
      
      // Initialize handlers if federation is enabled
      if (this.config?.instanceEnabled) {
        await this.initializeHandlers()
      }
      
      this.initialized = true
      console.log('✅ FederationManager: Initialized successfully')
      
      return { success: true }
      
    } catch (error) {
      console.error('❌ FederationManager: Initialization failed:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Process incoming ActivityPub activity
   */
  async processIncomingActivity(activity: ActivityPubActivity): Promise<{
    success: boolean
    error?: string
  }> {
    console.log('📥 FederationManager: Processing incoming activity:', activity.type)
    
    try {
      if (!this.config?.instanceEnabled) {
        console.log('🚫 Federation disabled, ignoring incoming activity')
        return { success: false, error: 'Federation disabled' }
      }
      
      if (!this.incomingHandler) {
        await this.initializeHandlers()
      }
      
      if (!this.incomingHandler) {
        return { success: false, error: 'Incoming handler not available' }
      }
      
      const result = await this.incomingHandler.processActivity(activity)
      return result
      
    } catch (error) {
      console.error('❌ FederationManager: Error processing incoming activity:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Get federation status
   */
  async getFederationStatus(): Promise<FederationStatus> {
    try {
      const config = await this.getConfig()
      
      if (!config.instanceEnabled) {
        return {
          enabled: false,
          health: 'offline'
        }
      }
      
      // Get queue status
      const { data: queueStats } = await supabase
        .from('federation_delivery_queue')
        .select('status')
        .in('status', ['pending', 'failed'])
      
      const queueSize = queueStats?.filter(item => item.status === 'pending').length || 0
      const failures = queueStats?.filter(item => item.status === 'failed').length || 0
      const total = queueStats?.length || 0
      const failureRate = total > 0 ? failures / total : 0
      
      // Get last activity
      const { data: lastActivity } = await supabase
        .from('ap_activities')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      // Determine health
      let health: 'healthy' | 'degraded' | 'offline' = 'healthy'
      if (failureRate > 0.5) {
        health = 'degraded'
      } else if (queueSize > 100) {
        health = 'degraded'
      }
      
      return {
        enabled: true,
        health,
        lastActivity: lastActivity?.created_at ? new Date(lastActivity.created_at) : undefined,
        queueSize,
        failureRate
      }
      
    } catch (error) {
      console.error('❌ Error getting federation status:', error)
      return {
        enabled: false,
        health: 'offline'
      }
    }
  }
  
  /**
   * Enable federation
   */
  async enableFederation(): Promise<{ success: boolean; error?: string }> {
    try {
      const { error } = await supabase
        .from('instance_config')
        .upsert([{
          config_key: 'federation_enabled',
          config_value: 'true'
        }])
      
      if (error) {
        return { success: false, error: error.message }
      }
      
      // Reload config and reinitialize
      await this.loadConfig()
      await this.initializeHandlers()
      
      console.log('✅ Federation enabled')
      return { success: true }
      
    } catch (error) {
      console.error('❌ Error enabling federation:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Disable federation
   */
  async disableFederation(): Promise<{ success: boolean; error?: string }> {
    try {
      const { error } = await supabase
        .from('instance_config')
        .upsert([{
          config_key: 'federation_enabled',
          config_value: 'false'
        }])
      
      if (error) {
        return { success: false, error: error.message }
      }
      
      // Clear handlers
      this.incomingHandler = null
      this.outgoingHandler = null
      
      // Reload config
      await this.loadConfig()
      
      console.log('🚫 Federation disabled')
      return { success: true }
      
    } catch (error) {
      console.error('❌ Error disabling federation:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Update user federation preferences
   */
  async updateUserPreferences(userId: string, preferences: {
    federationEnabled?: boolean
    autoAcceptFollows?: boolean
    publicTimeline?: boolean
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const updates: any = {}
      
      if (preferences.federationEnabled !== undefined) {
        updates.federation_enabled = preferences.federationEnabled
      }
      
      if (preferences.autoAcceptFollows !== undefined) {
        updates.auto_accept_follows = preferences.autoAcceptFollows
      }
      
      if (preferences.publicTimeline !== undefined) {
        updates.public_timeline = preferences.publicTimeline
      }
      
      const { error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', userId)
      
      if (error) {
        return { success: false, error: error.message }
      }
      
      console.log('✅ User federation preferences updated')
      return { success: true }
      
    } catch (error) {
      console.error('❌ Error updating user preferences:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Get user federation preferences
   */
  async getUserPreferences(userId: string): Promise<{
    success: boolean
    preferences?: {
      federationEnabled: boolean
      autoAcceptFollows: boolean
      publicTimeline: boolean
    }
    error?: string
  }> {
    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('federation_enabled, auto_accept_follows, public_timeline')
        .eq('id', userId)
        .single()
      
      if (error) {
        return { success: false, error: error.message }
      }
      
      return {
        success: true,
        preferences: {
          federationEnabled: profile.federation_enabled ?? true,
          autoAcceptFollows: profile.auto_accept_follows ?? true,
          publicTimeline: profile.public_timeline ?? true
        }
      }
      
    } catch (error) {
      console.error('❌ Error getting user preferences:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Retry failed federation activities
   */
  async retryFailedActivities(limit: number = 10): Promise<ProcessingResult> {
    try {
      const { data: failedActivities } = await supabase
        .from('federation_delivery_queue')
        .select('id, activity_id, target_domain')
        .eq('status', 'failed')
        .limit(limit)
      
      if (!failedActivities || failedActivities.length === 0) {
        return { success: true, processed: 0, failed: 0, errors: [] }
      }
      
      const results = {
        success: true,
        processed: 0,
        failed: 0,
        errors: [] as string[]
      }
      
      for (const item of failedActivities) {
        try {
          // Reset status to pending for retry
          const { error } = await supabase
            .from('federation_delivery_queue')
            .update({
              status: 'pending',
              attempts: 0,
              next_attempt_at: new Date()
            })
            .eq('id', item.id)
          
          if (error) {
            results.failed++
            results.errors.push(`Failed to reset ${item.id}: ${error.message}`)
          } else {
            results.processed++
          }
          
        } catch (error) {
          results.failed++
          results.errors.push(`Error processing ${item.id}: ${error.message}`)
        }
      }
      
      console.log(`🔄 Retry queued: ${results.processed} activities, ${results.failed} failed`)
      return results
      
    } catch (error) {
      console.error('❌ Error retrying failed activities:', error)
      return {
        success: false,
        processed: 0,
        failed: 0,
        errors: [error.message]
      }
    }
  }
  
  /**
   * Get current configuration
   */
  async getConfig(): Promise<FederationConfig> {
    if (!this.config) {
      const result = await this.loadConfig()
      if (!result.success) {
        throw new Error(result.error)
      }
    }
    return this.config!
  }
  
  /**
   * Check if federation is enabled for user
   */
  async isFederationEnabledForUser(userId: string): Promise<boolean> {
    try {
      const config = await this.getConfig()
      if (!config.instanceEnabled) {
        return false
      }
      
      const preferences = await this.getUserPreferences(userId)
      return preferences.success ? preferences.preferences!.federationEnabled : true
      
    } catch (error) {
      console.error('❌ Error checking user federation status:', error)
      return false
    }
  }
  
  // =============================================
  // PRIVATE METHODS
  // =============================================
  
  /**
   * Load federation configuration
   */
  private async loadConfig(): Promise<{ success: boolean; error?: string }> {
    try {
      const { data: configData } = await supabase
        .from('instance_config')
        .select('config_key, config_value')
        .in('config_key', ['federation_enabled', 'domain'])
      
      const federationEnabled = configData?.find(c => c.config_key === 'federation_enabled')?.config_value === 'true'
      const instanceDomain = configData?.find(c => c.config_key === 'domain')?.config_value?.replace(/"/g, '') || 'har.mony.lol'
      const instanceUrl = `https://${instanceDomain}`
      
      this.config = {
        instanceEnabled: federationEnabled,
        instanceDomain,
        instanceUrl
      }
      
      return { success: true }
      
    } catch (error) {
      console.error('❌ Error loading federation config:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Initialize federation handlers
   */
  private async initializeHandlers(): Promise<void> {
    if (!this.config?.instanceEnabled) {
      return
    }
    
    try {
      this.incomingHandler = await createIncomingHandler()
      this.outgoingHandler = await createOutgoingHandler()
      
      console.log('✅ Federation handlers initialized')
      
    } catch (error) {
      console.error('❌ Error initializing federation handlers:', error)
      throw error
    }
  }
}

// Export singleton instance
export const federationManager = FederationManager.getInstance()