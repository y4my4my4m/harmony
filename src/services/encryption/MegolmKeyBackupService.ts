/**
 * Megolm Key Backup Service
 * 
 * Handles server-side encrypted backup of Megolm session keys.
 * 
 * Security Model:
 * - All session keys are encrypted with user's recovery key before upload
 * - Server only stores encrypted blobs - cannot decrypt without recovery key
 * - User can restore all keys on new device using recovery phrase
 * 
 * Backup Storage:
 * - Stored in database table `megolm_key_backups`
 * - Each user has one backup that gets updated as sessions are created
 * - Backup is automatically updated when new sessions are created
 */

import { supabase } from '@/supabase'
import { recoveryKeyService } from './RecoveryKeyService'
import { megolmService, type MegolmOutboundSession, type MegolmInboundSession } from './MegolmService'

// Backup data structure
export interface MegolmBackupData {
  version: number
  userId: string
  timestamp: number
  sessions: {
    outbound: MegolmOutboundSession[]
    inbound: MegolmInboundSession[]
  }
}

// Backup metadata stored on server
export interface BackupMetadata {
  id: string
  user_id: string
  version: number
  session_count: number
  last_updated: string
  backup_hash: string
}

/**
 * Megolm Key Backup Service
 * Handles encrypted backup and restore of session keys
 */
export class MegolmKeyBackupService {
  private static instance: MegolmKeyBackupService
  private userId: string | null = null
  private autoBackupEnabled = true

  private constructor() {}

  static getInstance(): MegolmKeyBackupService {
    if (!MegolmKeyBackupService.instance) {
      MegolmKeyBackupService.instance = new MegolmKeyBackupService()
    }
    return MegolmKeyBackupService.instance
  }

  // =====================================================
  // INITIALIZATION
  // =====================================================

  async initialize(userId: string): Promise<void> {
    this.userId = userId
    console.log('✅ MegolmKeyBackupService initialized')
  }

  // =====================================================
  // BACKUP OPERATIONS
  // =====================================================

  /**
   * Create or update the encrypted backup on server
   */
  async createBackup(): Promise<void> {
    if (!this.userId) {
      throw new Error('Not initialized')
    }

    if (!recoveryKeyService.isLoaded()) {
      throw new Error('Recovery key not loaded - cannot create backup')
    }

    // Export all sessions from MegolmService
    const sessions = await megolmService.exportAllSessions()

    // Create backup data
    const backupData: MegolmBackupData = {
      version: 1,
      userId: this.userId,
      timestamp: Date.now(),
      sessions
    }

    // Encrypt with recovery key
    const backupJson = JSON.stringify(backupData)
    const encryptedBackup = await recoveryKeyService.encryptForBackup(backupJson)

    // Calculate hash for integrity check
    const hash = await this.calculateHash(backupJson)

    // Upsert to database
    const { error } = await supabase
      .from('megolm_key_backups')
      .upsert({
        user_id: this.userId,
        encrypted_data: encryptedBackup,
        version: 1,
        session_count: sessions.outbound.length + sessions.inbound.length,
        backup_hash: hash,
        last_updated: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      })

    if (error) {
      console.error('❌ Failed to create backup:', error)
      throw new Error(`Failed to create backup: ${error.message}`)
    }

    console.log(`✅ Backup created with ${sessions.outbound.length} outbound, ${sessions.inbound.length} inbound sessions`)
  }

  /**
   * Restore sessions from encrypted backup
   */
  async restoreFromBackup(): Promise<{
    outboundCount: number
    inboundCount: number
  }> {
    if (!this.userId) {
      throw new Error('Not initialized')
    }

    if (!recoveryKeyService.isLoaded()) {
      throw new Error('Recovery key not loaded - cannot restore backup')
    }

    // Fetch backup from database (use maybeSingle to avoid error on 0 rows)
    const { data: backup, error } = await supabase
      .from('megolm_key_backups')
      .select('encrypted_data, backup_hash, version')
      .eq('user_id', this.userId)
      .maybeSingle()

    if (error) {
      throw new Error(`Failed to fetch backup: ${error.message}`)
    }

    if (!backup) {
      console.log('ℹ️ No backup found for user')
      return { outboundCount: 0, inboundCount: 0 }
    }

    // Decrypt with recovery key
    let backupJson: string
    try {
      backupJson = await recoveryKeyService.decryptFromBackup(backup.encrypted_data)
    } catch (error) {
      throw new Error('Failed to decrypt backup - invalid recovery key?')
    }

    // Verify integrity
    const hash = await this.calculateHash(backupJson)
    if (hash !== backup.backup_hash) {
      console.warn('⚠️ Backup hash mismatch - data may be corrupted')
      // Continue anyway - user might want partial recovery
    }

    // Parse backup data
    const backupData: MegolmBackupData = JSON.parse(backupJson)

    if (backupData.version !== 1) {
      throw new Error(`Unsupported backup version: ${backupData.version}`)
    }

    if (backupData.userId !== this.userId) {
      throw new Error('Backup belongs to a different user')
    }

    // Import sessions into MegolmService
    await megolmService.importAllSessions(backupData.sessions)

    console.log(`✅ Restored ${backupData.sessions.outbound.length} outbound, ${backupData.sessions.inbound.length} inbound sessions`)

    return {
      outboundCount: backupData.sessions.outbound.length,
      inboundCount: backupData.sessions.inbound.length
    }
  }

  /**
   * Check if a backup exists for the user
   */
  async hasBackup(): Promise<boolean> {
    if (!this.userId) return false

    const { data } = await supabase
      .from('megolm_key_backups')
      .select('id')
      .eq('user_id', this.userId)
      .maybeSingle()

    return !!data
  }

  /**
   * Get backup metadata (without decrypting)
   */
  async getBackupMetadata(): Promise<BackupMetadata | null> {
    if (!this.userId) return null

    const { data } = await supabase
      .from('megolm_key_backups')
      .select('id, user_id, version, session_count, last_updated, backup_hash')
      .eq('user_id', this.userId)
      .maybeSingle()

    if (!data) {
      return null
    }

    return data as BackupMetadata
  }

  /**
   * Delete the backup
   */
  async deleteBackup(): Promise<void> {
    if (!this.userId) return

    const { error } = await supabase
      .from('megolm_key_backups')
      .delete()
      .eq('user_id', this.userId)

    if (error) {
      console.error('❌ Failed to delete backup:', error)
      throw new Error(`Failed to delete backup: ${error.message}`)
    }

    console.log('✅ Backup deleted')
  }

  // =====================================================
  // AUTO-BACKUP
  // =====================================================

  /**
   * Enable/disable automatic backup after session changes
   */
  setAutoBackup(enabled: boolean): void {
    this.autoBackupEnabled = enabled
  }

  /**
   * Trigger backup if auto-backup is enabled
   * Called after creating new sessions
   */
  async triggerAutoBackup(): Promise<void> {
    if (!this.autoBackupEnabled) return

    try {
      await this.createBackup()
    } catch (error) {
      console.warn('⚠️ Auto-backup failed:', error)
      // Don't throw - auto-backup failure shouldn't block operations
    }
  }

  // =====================================================
  // CROSS-DEVICE KEY SHARING
  // =====================================================

  /**
   * Request to receive session keys from another device
   * Creates a key request that the other device can fulfill
   */
  async createKeyRequest(roomId: string, sessionId: string): Promise<string> {
    if (!this.userId) {
      throw new Error('Not initialized')
    }

    const requestId = crypto.randomUUID()

    const { error } = await supabase
      .from('megolm_key_requests')
      .insert({
        id: requestId,
        user_id: this.userId,
        room_id: roomId,
        session_id: sessionId,
        status: 'pending',
        created_at: new Date().toISOString()
      })

    if (error) {
      throw new Error(`Failed to create key request: ${error.message}`)
    }

    console.log(`📤 Created key request ${requestId} for session ${sessionId}`)
    return requestId
  }

  /**
   * Check for pending key requests from other devices
   */
  async getPendingKeyRequests(): Promise<{
    id: string
    room_id: string
    session_id: string
    created_at: string
  }[]> {
    if (!this.userId) return []

    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('id, room_id, session_id, created_at')
      .eq('user_id', this.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('❌ Failed to fetch key requests:', error)
      return []
    }

    return data || []
  }

  /**
   * Fulfill a key request by sharing the session key
   * The key is encrypted with the requesting user's public key
   */
  async fulfillKeyRequest(
    requestId: string,
    sessionKey: string,
    encryptedForRecipient: string
  ): Promise<void> {
    const { error } = await supabase
      .from('megolm_key_requests')
      .update({
        status: 'fulfilled',
        encrypted_key: encryptedForRecipient,
        fulfilled_at: new Date().toISOString()
      })
      .eq('id', requestId)

    if (error) {
      throw new Error(`Failed to fulfill key request: ${error.message}`)
    }

    console.log(`✅ Fulfilled key request ${requestId}`)
  }

  /**
   * Check if a key request has been fulfilled
   */
  async checkKeyRequestStatus(requestId: string): Promise<{
    status: 'pending' | 'fulfilled' | 'expired'
    encryptedKey?: string
  }> {
    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('status, encrypted_key')
      .eq('id', requestId)
      .single()

    if (error || !data) {
      return { status: 'expired' }
    }

    return {
      status: data.status as 'pending' | 'fulfilled' | 'expired',
      encryptedKey: data.encrypted_key
    }
  }

  // =====================================================
  // UTILITY METHODS
  // =====================================================

  /**
   * Calculate SHA-256 hash of data
   */
  private async calculateHash(data: string): Promise<string> {
    const encoder = new TextEncoder()
    const dataBytes = encoder.encode(data)
    const hash = await crypto.subtle.digest('SHA-256', dataBytes)
    const hashArray = Array.from(new Uint8Array(hash))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Export backup data for local file storage
   */
  async exportToFile(): Promise<string> {
    if (!this.userId || !recoveryKeyService.isLoaded()) {
      throw new Error('Not initialized or recovery key not loaded')
    }

    const sessions = await megolmService.exportAllSessions()

    const exportData = {
      type: 'harmony-megolm-backup',
      version: 1,
      userId: this.userId,
      timestamp: Date.now(),
      sessions
    }

    // Encrypt with recovery key
    const json = JSON.stringify(exportData)
    return await recoveryKeyService.encryptForBackup(json)
  }

  /**
   * Import backup from local file
   */
  async importFromFile(encryptedData: string): Promise<{
    outboundCount: number
    inboundCount: number
  }> {
    if (!recoveryKeyService.isLoaded()) {
      throw new Error('Recovery key not loaded')
    }

    // Decrypt
    const json = await recoveryKeyService.decryptFromBackup(encryptedData)
    const importData = JSON.parse(json)

    if (importData.type !== 'harmony-megolm-backup') {
      throw new Error('Invalid backup file format')
    }

    if (importData.version !== 1) {
      throw new Error(`Unsupported backup version: ${importData.version}`)
    }

    // Import sessions
    await megolmService.importAllSessions(importData.sessions)

    return {
      outboundCount: importData.sessions.outbound.length,
      inboundCount: importData.sessions.inbound.length
    }
  }
}

// Export singleton
export const megolmKeyBackupService = MegolmKeyBackupService.getInstance()

