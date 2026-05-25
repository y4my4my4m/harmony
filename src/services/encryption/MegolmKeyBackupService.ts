/**
 * Megolm Key Backup Service
 * 
 * Handles server-side encrypted backup of Megolm session keys AND
 * realtime key request/fulfillment for cross-device key sharing.
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
 * 
 * Realtime Key Requests (NEW):
 * - When a user can't decrypt a message, they create a key request
 * - The sender receives this request via realtime subscription
 * - Sender automatically fulfills the request if they have the session key
 * - Requester receives the fulfilled key via realtime and imports it
 */

import { supabase } from '@/supabase'
import { recoveryKeyService } from './RecoveryKeyService'
import { megolmService, type MegolmOutboundSession, type MegolmInboundSession } from './MegolmService'
import { identityKeyStore } from './SecureSessionKeyStore'
import { userEventChannel } from '@/services/UserEventChannel'
import { debug } from '@/utils/debug'

// Key request from the database
export interface KeyRequest {
  id: string
  requester_user_id: string
  sender_user_id: string
  room_id: string
  session_id: string
  status: 'pending' | 'fulfilled' | 'expired' | 'cancelled'
  encrypted_key?: string
  created_at: string
  fulfilled_at?: string
}

// Callback for when a key is received
export type KeyReceivedCallback = (roomId: string, sessionId: string) => void

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
 * AND realtime key request/fulfillment
 */
export class MegolmKeyBackupService {
  private static instance: MegolmKeyBackupService
  private userId: string | null = null
  private autoBackupEnabled = true

  private broadcastUnsubs: Array<() => void> = []

  private keyReceivedCallbacks: Set<KeyReceivedCallback> = new Set()

  private pendingRequests: Map<string, string> = new Map()

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
    // Clean up old subscriptions if re-initializing
    if (this.userId && this.userId !== userId) {
      this.cleanup()
    }

    this.userId = userId
    
    // Set up realtime subscriptions for key requests
    await this.setupRealtimeSubscriptions()
    
    debug.log('✅ MegolmKeyBackupService initialized with realtime key request support')
  }

  /**
   * Set up broadcast handlers for key request flow via user:{id} channel.
   */
  private async setupRealtimeSubscriptions(): Promise<void> {
    if (!this.userId) return

    for (const unsub of this.broadcastUnsubs) unsub()
    this.broadcastUnsubs = []

    userEventChannel.connect(this.userId)

    this.broadcastUnsubs.push(
      userEventChannel.on('encryption:key_request', (data) => {
        this.handleIncomingKeyRequest(data as unknown as KeyRequest)
      })
    )

    this.broadcastUnsubs.push(
      userEventChannel.on('encryption:key_fulfilled', (data) => {
        this.handleFulfilledRequest(data as unknown as KeyRequest)
      })
    )

    debug.log('🔔 Encryption key request handlers registered via user:{id} broadcast')
  }

  /**
   * Handle an incoming key request from another user
   * Auto-fulfill if we have the session key
   */
  private async handleIncomingKeyRequest(request: KeyRequest): Promise<void> {
    debug.log(`📩 Received key request from ${request.requester_user_id.substring(0, 8)}... for session ${request.session_id.substring(0, 8)}...`)

    if (!megolmService.isInitialized()) {
      debug.log('⏸️ Megolm not initialized, cannot fulfill request')
      return
    }

    try {
      // Look for the session in our inbound sessions (we might have it)
      const session = megolmService.findInboundSessionBySessionId(request.room_id, request.session_id)
      
      if (!session) {
        debug.log(`ℹ️ Don't have session ${request.session_id.substring(0, 8)}...`)
        return
      }

      debug.log(`✅ Found session, fulfilling request...`)

      // Get the requester's public key for encryption
      const { data: requesterKey } = await supabase
        .from('user_key_pairs')
        .select('identity_public_key')
        .eq('user_id', request.requester_user_id)
        .eq('is_active', true)
        .maybeSingle()

      if (!requesterKey?.identity_public_key) {
        debug.log(`⚠️ Requester has no public key, cannot fulfill`)
        return
      }

      // Encrypt the session key for the requester
      const encryptedKey = await this.encryptSessionKeyForUser(
        session.sessionKey,
        requesterKey.identity_public_key
      )

      // Fulfill the request
      const { error } = await supabase
        .from('megolm_key_requests')
        .update({
          status: 'fulfilled',
          encrypted_key: encryptedKey,
          fulfilled_at: new Date().toISOString()
        })
        .eq('id', request.id)

      if (error) {
        debug.error('❌ Failed to fulfill request:', error)
        return
      }

      debug.log(`✅ Fulfilled key request ${request.id.substring(0, 8)}...`)
    } catch (error) {
      debug.error('❌ Error handling key request:', error)
    }
  }

  /**
   * Handle a fulfilled key request (we requested a key and got it)
   */
  private async handleFulfilledRequest(request: KeyRequest): Promise<void> {
    debug.log(`📬 Key request fulfilled! Session ${request.session_id.substring(0, 8)}...`)

    if (!request.encrypted_key) {
      debug.log('⚠️ Fulfilled request has no encrypted key')
      return
    }

    try {
      // Fetch fulfiller's (sender's) public key for ECDH decryption
      const { data: senderKey } = await supabase
        .from('user_key_pairs')
        .select('identity_public_key')
        .eq('user_id', request.sender_user_id)
        .eq('is_active', true)
        .maybeSingle()

      if (!senderKey?.identity_public_key) {
        debug.warn(`⚠️ No public key for sender ${request.sender_user_id.substring(0, 8)}, cannot decrypt`)
        return
      }

      const sessionKey = await this.decryptSessionKeyFromSender(
        request.encrypted_key,
        senderKey.identity_public_key
      )

      // Import the session
      await megolmService.importInboundSession(
        request.room_id,
        request.sender_user_id,
        request.session_id,
        sessionKey,
        0 // firstKnownIndex
      )

      debug.log(`✅ Imported session ${request.session_id.substring(0, 8)}... from fulfilled request`)

      // Remove from pending requests
      this.pendingRequests.delete(request.session_id)

      // Notify callbacks (so UI can retry decryption)
      for (const callback of this.keyReceivedCallbacks) {
        try {
          callback(request.room_id, request.session_id)
        } catch (e) {
          debug.error('Error in key received callback:', e)
        }
      }

      // Create backup with the new session
      this.triggerAutoBackup().catch(() => {})
    } catch (error) {
      debug.error('❌ Error importing fulfilled key:', error)
    }
  }

  // =====================================================
  // ECDH Key Exchange Helpers
  // =====================================================

  private async getMyPrivateKey(): Promise<CryptoKey> {
    if (!this.userId) throw new Error('Not initialized')
    const key = await identityKeyStore.load(this.userId)
    if (key) return key
    throw new Error('Identity private key not found - run encryption setup')
  }

  private async importPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
    const bytes = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0))
    return crypto.subtle.importKey(
      'raw', bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    )
  }

  private async deriveSharedKey(
    privateKey: CryptoKey,
    publicKey: CryptoKey,
    usage: KeyUsage[]
  ): Promise<CryptoKey> {
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: publicKey }, privateKey, 256
    )
    const hkdfKey = await crypto.subtle.importKey(
      'raw', sharedBits, 'HKDF', false, ['deriveKey']
    )
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('harmony-megolm-session-exchange'),
        info: new TextEncoder().encode('session-key-encryption'),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usage
    )
  }

  /**
   * Encrypt a session key for a specific user using ECDH key agreement.
   */
  private async encryptSessionKeyForUser(sessionKey: string, recipientPublicKey: string): Promise<string> {
    const myPrivateKey = await this.getMyPrivateKey()
    const recipientKey = await this.importPublicKey(recipientPublicKey)
    const aesKey = await this.deriveSharedKey(myPrivateKey, recipientKey, ['encrypt'])

    const encoder = new TextEncoder()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, aesKey, encoder.encode(sessionKey)
    )

    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)

    return 'v2:' + btoa(String.fromCharCode(...combined))
  }

  /**
   * Decrypt a session key using ECDH with the sender's public key.
   */
  private async decryptSessionKeyFromSender(
    encryptedKey: string,
    senderPublicKey: string
  ): Promise<string> {
    const payload = encryptedKey.startsWith('v2:')
      ? encryptedKey.slice(3)
      : encryptedKey

    const myPrivateKey = await this.getMyPrivateKey()
    const senderKey = await this.importPublicKey(senderPublicKey)
    const aesKey = await this.deriveSharedKey(myPrivateKey, senderKey, ['decrypt'])

    const combined = Uint8Array.from(atob(payload), c => c.charCodeAt(0))
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, aesKey, ciphertext
    )
    return new TextDecoder().decode(decrypted)
  }

  /**
   * Register a callback for when keys are received
   * Used by UI components to retry decryption
   */
  onKeyReceived(callback: KeyReceivedCallback): () => void {
    this.keyReceivedCallbacks.add(callback)
    return () => this.keyReceivedCallbacks.delete(callback)
  }

  /**
   * Clean up subscriptions
   */
  cleanup(): void {
    for (const unsub of this.broadcastUnsubs) unsub()
    this.broadcastUnsubs = []
    this.keyReceivedCallbacks.clear()
    this.pendingRequests.clear()
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
      debug.error('❌ Failed to create backup:', error)
      throw new Error(`Failed to create backup: ${error.message}`)
    }

    debug.log(`✅ Backup created with ${sessions.outbound.length} outbound, ${sessions.inbound.length} inbound sessions`)
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
      debug.log('ℹ️ No backup found for user')
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
      debug.warn('⚠️ Backup hash mismatch - data may be corrupted')
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

    debug.log(`✅ Restored ${backupData.sessions.outbound.length} outbound, ${backupData.sessions.inbound.length} inbound sessions`)

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
      debug.error('❌ Failed to delete backup:', error)
      throw new Error(`Failed to delete backup: ${error.message}`)
    }

    debug.log('✅ Backup deleted')
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
      debug.warn('⚠️ Auto-backup failed:', error)
      // Don't throw - auto-backup failure shouldn't block operations
    }
  }

  // =====================================================
  // CROSS-DEVICE KEY SHARING (with Realtime)
  // =====================================================

  /**
   * Request a session key from the sender
   * The sender will receive this via realtime and auto-fulfill if they have the key
   * 
   * @param roomId - The room/channel/conversation ID
   * @param sessionId - The Megolm session ID needed
   * @param senderUserId - The user who sent the original message (and has the key)
   */
  async createKeyRequest(roomId: string, sessionId: string, senderUserId?: string): Promise<string> {
    if (!this.userId) {
      throw new Error('Not initialized')
    }

    // Check if we already have a pending request for this session
    const existingRequestId = this.pendingRequests.get(sessionId)
    if (existingRequestId) {
      debug.log(`ℹ️ Already have pending request for session ${sessionId.substring(0, 8)}...`)
      return existingRequestId
    }

    const requestId = crypto.randomUUID()

    const { error } = await supabase
      .from('megolm_key_requests')
      .insert({
        id: requestId,
        user_id: this.userId, // Legacy field for backwards compatibility
        requester_user_id: this.userId,
        sender_user_id: senderUserId || null, // Who we're requesting the key from
        room_id: roomId,
        session_id: sessionId,
        status: 'pending',
        created_at: new Date().toISOString()
      })

    if (error) {
      throw new Error(`Failed to create key request: ${error.message}`)
    }

    // Track pending request
    this.pendingRequests.set(sessionId, requestId)

    debug.log(`📤 Created key request ${requestId.substring(0, 8)}... for session ${sessionId.substring(0, 8)}... from ${senderUserId?.substring(0, 8) || 'unknown'}`)
    return requestId
  }

  /**
   * Check for pending key requests we've made
   */
  async getMyPendingRequests(): Promise<KeyRequest[]> {
    if (!this.userId) return []

    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('*')
      .eq('requester_user_id', this.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      debug.error('❌ Failed to fetch my pending requests:', error)
      return []
    }

    return (data || []) as KeyRequest[]
  }

  /**
   * Check for requests others have made to me
   */
  async getRequestsToMe(): Promise<KeyRequest[]> {
    if (!this.userId) return []

    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('*')
      .eq('sender_user_id', this.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      debug.error('❌ Failed to fetch requests to me:', error)
      return []
    }

    return (data || []) as KeyRequest[]
  }

  /**
   * Process any pending requests to me (fulfill if we have the keys)
   * Called on initialization to catch up on requests made while offline
   */
  async processPendingRequestsToMe(): Promise<number> {
    const requests = await this.getRequestsToMe()
    let fulfilledCount = 0

    for (const request of requests) {
      try {
        await this.handleIncomingKeyRequest(request)
        fulfilledCount++
      } catch (error) {
        debug.warn(`⚠️ Failed to process request ${request.id}:`, error)
      }
    }

    if (fulfilledCount > 0) {
      debug.log(`✅ Processed ${fulfilledCount} pending key requests`)
    }

    return fulfilledCount
  }

  /**
   * Cancel a pending key request
   */
  async cancelKeyRequest(requestId: string): Promise<void> {
    const { error } = await supabase
      .from('megolm_key_requests')
      .update({ status: 'cancelled' })
      .eq('id', requestId)
      .eq('requester_user_id', this.userId)

    if (error) {
      debug.error('❌ Failed to cancel request:', error)
    }

    // Remove from pending
    for (const [sessionId, id] of this.pendingRequests) {
      if (id === requestId) {
        this.pendingRequests.delete(sessionId)
        break
      }
    }
  }

  /**
   * Check if a key request has been fulfilled
   */
  async checkKeyRequestStatus(requestId: string): Promise<{
    status: 'pending' | 'fulfilled' | 'expired' | 'cancelled'
    encryptedKey?: string
  }> {
    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('status, encrypted_key')
      .eq('id', requestId)
      .maybeSingle()

    if (error || !data) {
      return { status: 'expired' }
    }

    return {
      status: data.status as 'pending' | 'fulfilled' | 'expired' | 'cancelled',
      encryptedKey: data.encrypted_key
    }
  }

  /**
   * @deprecated Use getMyPendingRequests instead
   */
  async getPendingKeyRequests(): Promise<{
    id: string
    room_id: string
    session_id: string
    created_at: string
  }[]> {
    const requests = await this.getMyPendingRequests()
    return requests.map(r => ({
      id: r.id,
      room_id: r.room_id,
      session_id: r.session_id,
      created_at: r.created_at
    }))
  }

  /**
   * @deprecated Use handleIncomingKeyRequest (auto-called via realtime)
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

    debug.log(`✅ Fulfilled key request ${requestId}`)
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

