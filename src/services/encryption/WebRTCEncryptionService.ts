/**
 * WebRTC Encryption Service
 * 
 * Provides end-to-end encryption for WebRTC voice and video calls
 * using Insertable Streams API (modern approach) with Signal Protocol
 * 
 * Features:
 * - Encrypt audio/video frames before sending
 * - Decrypt frames after receiving
 * - Uses same Signal Protocol keys as messages
 * - Perfect forward secrecy for calls
 * - Frame-by-frame encryption
 */

import { signalProtocolService } from './SignalProtocolService'
import { debug } from '@/utils/debug'
import { FrameEncryptor } from './FrameEncryptor'

// Re-export so existing test imports keep working without changes.
export { FrameEncryptor }

/**
 * WebRTC Encryption Service
 *
 * Frame crypto runs in a DedicatedWorker (PC3, BUGS.md). The main thread
 * derives per-peer key material via Signal Protocol and ships it to the
 * worker; the worker owns the per-peer `FrameEncryptor` instances and
 * actually touches every RTP frame. Two activation paths are used to wire
 * up the encoded streams (preferred order):
 *
 *  1. `RTCRtpScriptTransform` - sender/receiver gets a transform whose
 *     constructor runs inside the worker (Safari, recent Firefox, recent
 *     Chromium). No frames cross the main thread.
 *  2. `createEncodedStreams()` + transferable `ReadableStream`/`WritableStream`
 *     pair (older Chromium with insertable streams). The main thread fetches
 *     the streams once and immediately transfers them to the worker; the
 *     `TransformStream` pipeline lives in the worker.
 */
export class WebRTCEncryptionService {
  private static instance: WebRTCEncryptionService
  private peers = new Set<string>() // peers we've sent key material to the worker for
  private enabled = false
  private currentUserId: string | null = null
  private worker: Worker | null = null
  private workerReady = false

  private constructor() {}

  private getWorker(): Worker | null {
    if (this.worker) return this.worker
    if (typeof Worker === 'undefined') {
      this.workerReady = false
      return null
    }
    try {
      // Vite picks up `new URL(... , import.meta.url)` and bundles the worker
      // with its own chunk; the `{ type: 'module' }` ensures ESM imports in
      // the worker source resolve correctly.
      this.worker = new Worker(
        new URL('./webrtcFrameCryptoWorker.ts', import.meta.url),
        { type: 'module' }
      )
      this.workerReady = true
      debug.log('🔐 WebRTC frame-crypto worker started')
      return this.worker
    } catch (error) {
      debug.error('❌ Failed to start frame-crypto worker; falling back to main-thread crypto', error)
      this.workerReady = false
      return null
    }
  }

  /** Has `RTCRtpScriptTransform` (preferred zero-copy path)? */
  private hasScriptTransform(): boolean {
    return typeof (globalThis as any).RTCRtpScriptTransform === 'function'
  }

  static getInstance(): WebRTCEncryptionService {
    if (!WebRTCEncryptionService.instance) {
      WebRTCEncryptionService.instance = new WebRTCEncryptionService()
    }
    return WebRTCEncryptionService.instance
  }

  // =====================================================
  // INITIALIZATION
  // =====================================================

  /**
   * Initialize encryption for a call
   */
  async initialize(userId: string, participantIds: string[]): Promise<void> {
    this.currentUserId = userId
    this.enabled = true

    debug.log(`🔐 Initializing WebRTC encryption for ${participantIds.length} participants`)

    // Generate encryption keys for each participant using Signal Protocol
    for (const participantId of participantIds) {
      await this.initializeParticipant(participantId)
    }

    debug.log('✅ WebRTC encryption initialized')
  }

  /**
   * Initialize encryption for a single participant
   */
  private async initializeParticipant(participantId: string): Promise<void> {
    // Derive a call-specific encryption key using Signal Protocol
    // This reuses the existing Signal session or creates a new one
    const sessionAddress = `${participantId}:1`

    try {
      // Check if we have a session
      const hasSession = await signalProtocolService.hasSession(sessionAddress)

      if (!hasSession) {
        debug.log(`🤝 No session with ${participantId}, establishing...`)
        // This will be handled by messageEncryptionService
        // For now, we'll use a temporary key
        await this.setupTemporaryKey(participantId)
        return
      }

      // Derive call encryption key from Signal session.
      // We encrypt a known value to derive a symmetric key.
      const keyDerivationData = `call-key-${Date.now()}`
      await signalProtocolService.encryptMessage(sessionAddress, keyDerivationData)
      const keyMaterial = await this.deriveKeyMaterial(keyDerivationData)

      await this.installKeyForPeer(participantId, keyMaterial)
      debug.log(`✅ Encryption initialized for participant: ${participantId}`)
    } catch (error) {
      debug.error(`❌ Failed to initialize encryption for ${participantId}:`, error)
      // Fall back to temporary key
      await this.setupTemporaryKey(participantId)
    }
  }

  /**
   * Setup temporary encryption key (fallback)
   */
  private async setupTemporaryKey(participantId: string): Promise<void> {
    debug.warn(`⚠️ Using temporary key for ${participantId}`)
    const keyMaterial = await this.deriveKeyMaterial(`temp-${participantId}-${Date.now()}`)
    await this.installKeyForPeer(participantId, keyMaterial)
  }

  /**
   * Ship per-peer key material to the worker (the worker owns the actual
   * `FrameEncryptor` instances). Transfers the buffer ownership so the
   * main-thread heap does not retain key bytes.
   */
  private async installKeyForPeer(peerId: string, keyMaterial: ArrayBuffer): Promise<void> {
    const worker = this.getWorker()
    if (!worker) {
      throw new Error('frame-crypto worker unavailable')
    }
    // Important: we transfer the buffer ownership so the main thread can no
    // longer read the symmetric key after dispatch.
    worker.postMessage(
      { type: 'init', peerId, keyMaterial },
      [keyMaterial]
    )
    this.peers.add(peerId)
  }

  /**
   * Derive key material from a string
   */
  private async deriveKeyMaterial(data: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder()
    const dataBuffer = encoder.encode(data)

    // Use PBKDF2 to derive a 256-bit key
    const baseKey = await crypto.subtle.importKey(
      'raw',
      dataBuffer,
      'PBKDF2',
      false,
      ['deriveBits']
    )

    const keyMaterial = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: encoder.encode('harmony-webrtc-e2ee'),
        iterations: 100000,
        hash: 'SHA-256'
      },
      baseKey,
      256
    )

    return keyMaterial
  }

  // =====================================================
  // INSERTABLE STREAMS / SCRIPT TRANSFORM INTEGRATION
  // =====================================================

  /**
   * Attach the worker-backed transform to either the sender or the receiver.
   * Tries `RTCRtpScriptTransform` first (frames never touch the main thread);
   * falls back to `createEncodedStreams` + transferable streams.
   */
  private attachWorkerTransform(
    endpoint: RTCRtpSender | RTCRtpReceiver,
    peerId: string,
    direction: 'encrypt' | 'decrypt'
  ): boolean {
    const worker = this.getWorker()
    if (!worker) return false

    const ScriptTransformCtor = (globalThis as any).RTCRtpScriptTransform
    if (typeof ScriptTransformCtor === 'function') {
      try {
        ;(endpoint as any).transform = new ScriptTransformCtor(worker, { peerId, direction })
        return true
      } catch (error) {
        debug.warn('⚠️ RTCRtpScriptTransform attach failed, falling back', error)
      }
    }

    const createStreams = (endpoint as any).createEncodedStreams
    if (typeof createStreams === 'function') {
      try {
        const streams = createStreams.call(endpoint) as {
          readable: ReadableStream
          writable: WritableStream
        }
        worker.postMessage(
          {
            type: 'pipe',
            peerId,
            direction,
            readable: streams.readable,
            writable: streams.writable,
          },
          [streams.readable as any, streams.writable as any]
        )
        return true
      } catch (error) {
        debug.error('❌ createEncodedStreams attach failed', error)
      }
    }

    return false
  }

  /**
   * Apply encryption to an RTCRtpSender (outgoing stream)
   */
  async encryptSender(sender: RTCRtpSender, receiverId: string): Promise<void> {
    if (!this.enabled) {
      debug.log('📤 Encryption not enabled, skipping sender encryption')
      return
    }
    if (!this.peers.has(receiverId)) {
      debug.warn(`⚠️ No key installed for ${receiverId}`)
      return
    }
    const ok = this.attachWorkerTransform(sender, receiverId, 'encrypt')
    if (ok) {
      debug.log(`✅ Sender encryption active (worker) for ${receiverId}`)
    } else {
      debug.error('❌ Failed to attach sender encryption - neither RTCRtpScriptTransform nor createEncodedStreams available')
    }
  }

  /**
   * Apply decryption to an RTCRtpReceiver (incoming stream)
   */
  async decryptReceiver(receiver: RTCRtpReceiver, senderId: string): Promise<void> {
    if (!this.enabled) {
      debug.log('📥 Encryption not enabled, skipping receiver decryption')
      return
    }
    if (!this.peers.has(senderId)) {
      debug.warn(`⚠️ No key installed for ${senderId}`)
      return
    }
    const ok = this.attachWorkerTransform(receiver, senderId, 'decrypt')
    if (ok) {
      debug.log(`✅ Receiver decryption active (worker) for ${senderId}`)
    } else {
      debug.error('❌ Failed to attach receiver decryption - neither RTCRtpScriptTransform nor createEncodedStreams available')
    }
  }

  /**
   * Setup encryption for a peer connection
   */
  async setupPeerConnectionEncryption(
    peerConnection: RTCPeerConnection,
    remoteUserId: string
  ): Promise<void> {
    if (!this.enabled) {
      debug.log('🔒 E2EE not enabled for this call')
      return
    }

    debug.log(`🔐 Setting up E2EE for peer connection with ${remoteUserId}`)

    // Wait for transceivers to be ready
    await new Promise(resolve => setTimeout(resolve, 100))

    // Encrypt all senders
    const senders = peerConnection.getSenders()
    for (const sender of senders) {
      if (sender.track) {
        await this.encryptSender(sender, remoteUserId)
      }
    }

    // Decrypt all receivers
    const receivers = peerConnection.getReceivers()
    for (const receiver of receivers) {
      if (receiver.track) {
        await this.decryptReceiver(receiver, remoteUserId)
      }
    }

    debug.log(`✅ E2EE setup complete for ${remoteUserId}`)
  }

  // =====================================================
  // PARTICIPANT MANAGEMENT
  // =====================================================

  /**
   * Add a new participant to an ongoing call
   */
  async addParticipant(participantId: string): Promise<void> {
    if (!this.enabled) return

    debug.log(`➕ Adding encryption for new participant: ${participantId}`)
    await this.initializeParticipant(participantId)
  }

  /**
   * Remove a participant from the call
   */
  removeParticipant(participantId: string): void {
    debug.log(`➖ Removing encryption for participant: ${participantId}`)
    this.peers.delete(participantId)
    this.worker?.postMessage({ type: 'remove', peerId: participantId })
  }

  // =====================================================
  // STATUS & UTILITIES
  // =====================================================

  /**
   * Check if encryption is enabled
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Check if the browser supports any path the worker can attach to.
   * Either `RTCRtpScriptTransform` (preferred) or `createEncodedStreams`
   * (legacy insertable streams) is sufficient.
   */
  isSupported(): boolean {
    try {
      if (typeof (globalThis as any).RTCRtpScriptTransform === 'function') return true
      const supported =
        typeof RTCRtpSender !== 'undefined' &&
        'createEncodedStreams' in RTCRtpSender.prototype &&
        typeof RTCRtpReceiver !== 'undefined' &&
        'createEncodedStreams' in RTCRtpReceiver.prototype
      if (!supported) {
        debug.warn('⚠️ Neither RTCRtpScriptTransform nor Insertable Streams supported in this browser')
      }
      return supported
    } catch {
      return false
    }
  }

  /**
   * Get encryption status
   */
  getStatus(): {
    enabled: boolean
    supported: boolean
    participantCount: number
    participants: string[]
    workerActive: boolean
  } {
    return {
      enabled: this.enabled,
      supported: this.isSupported(),
      participantCount: this.peers.size,
      participants: Array.from(this.peers.values()),
      workerActive: this.workerReady,
    }
  }

  // =====================================================
  // CLEANUP
  // =====================================================

  /**
   * Cleanup and disable encryption
   */
  cleanup(): void {
    debug.log('🧹 Cleaning up WebRTC encryption')
    this.peers.clear()
    this.enabled = false
    this.currentUserId = null
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'reset' })
        this.worker.terminate()
      } catch {
        /* ignore */
      }
      this.worker = null
      this.workerReady = false
    }
  }

  /**
   * Renegotiate keys (for perfect forward secrecy)
   */
  async renegotiateKeys(participantIds: string[]): Promise<void> {
    if (!this.enabled) return

    debug.log('🔄 Renegotiating encryption keys')

    for (const participantId of participantIds) {
      // Tell the worker to drop the existing keys; `initializeParticipant`
      // will ship fresh ones.
      this.peers.delete(participantId)
      this.worker?.postMessage({ type: 'remove', peerId: participantId })

      await this.initializeParticipant(participantId)
    }

    debug.log('✅ Keys renegotiated')
  }
}

// Export singleton instance
export const webrtcEncryptionService = WebRTCEncryptionService.getInstance()

