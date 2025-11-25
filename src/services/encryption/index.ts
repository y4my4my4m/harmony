/**
 * Encryption Services
 * 
 * IMPORTANT: These services use @signalapp/libsignal-client which is a Node.js native module.
 * For browser compatibility, these should be imported LAZILY when needed, not at module load time.
 * 
 * DO NOT import these directly in components that load immediately.
 * Use dynamic imports instead:
 * 
 * ❌ BAD:
 * import { messageEncryptionService } from '@/services/encryption'
 * 
 * ✅ GOOD:
 * const { messageEncryptionService } = await import('@/services/encryption')
 */

// Lazy exports - these will only load when actually called
export const getSignalProtocolService = () => import('./SignalProtocolService').then(m => m.signalProtocolService)
export const getEncryptionKeyStore = () => import('./EncryptionKeyStore').then(m => m.EncryptionKeyStore)
export const getMessageEncryptionService = () => import('./MessageEncryptionService').then(m => m.messageEncryptionService)
export const getWebRTCEncryptionService = () => import('./WebRTCEncryptionService').then(m => m.webrtcEncryptionService)

// Type exports (these are safe - they're compile-time only)
export type {
  KeyPair,
  PreKey,
  SignedPreKey,
  PreKeyBundleData,
  EncryptedMessage
} from './SignalProtocolService'

export type {
  EncryptionStatus,
  EncryptedMessageData
} from './MessageEncryptionService'

// Legacy direct exports for backward compatibility - will throw error if Signal Protocol isn't available
// These should be phased out in favor of lazy loading
export { signalProtocolService } from './SignalProtocolService'
export { EncryptionKeyStore } from './EncryptionKeyStore'
export { messageEncryptionService } from './MessageEncryptionService'
export { webrtcEncryptionService } from './WebRTCEncryptionService'


