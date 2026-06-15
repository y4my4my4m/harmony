/**
 * Encryption Services
 * 
 * IMPORTANT: These services should be imported LAZILY when needed, not at module load time.
 * 
 * DO NOT import these directly in components that load immediately.
 * Use dynamic imports instead:
 * 
 * ❌ BAD:
 * import { messageEncryptionService } from '@/services/encryption'
 * 
 * ✅ GOOD:
 * const { messageEncryptionService } = await import('@/services/encryption')
 * 
 * NEW: Megolm-style encryption (recommended for new code)
 * const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
 */


// Lazy exports for Megolm services
export const getMegolmService = () => import('./MegolmService').then(m => m.megolmService)
export const getRecoveryKeyService = () => import('./RecoveryKeyService').then(m => m.recoveryKeyService)
export const getMegolmKeyBackupService = () => import('./MegolmKeyBackupService').then(m => m.megolmKeyBackupService)
export const getMegolmMessageEncryptionService = () => import('./MegolmMessageEncryptionService').then(m => m.megolmMessageEncryptionService)

// Type exports for Megolm
export type {
  MegolmOutboundSession,
  MegolmInboundSession,
  MegolmEncryptedMessage
} from './MegolmService'

export type {
  RecoveryKeyData,
  DerivedKeys
} from './RecoveryKeyService'

export type {
  MegolmBackupData,
  BackupMetadata
} from './MegolmKeyBackupService'

export type {
  MegolmEncryptionStatus,
  MegolmEncryptedMessageData
} from './MegolmMessageEncryptionService'

// Direct exports for Megolm services (use lazy loading in production)
export { megolmService } from './MegolmService'
export { recoveryKeyService } from './RecoveryKeyService'
export { megolmKeyBackupService } from './MegolmKeyBackupService'
export { megolmMessageEncryptionService } from './MegolmMessageEncryptionService'


// WebRTC encryption (still uses Signal Protocol for calls)
export const getWebRTCEncryptionService = () => import('./WebRTCEncryptionService').then(m => m.webrtcEncryptionService)
export { webrtcEncryptionService } from './WebRTCEncryptionService'

// DEPRECATED: Signal Protocol services - DO NOT USE for new code
// These exports are kept only for WebRTC and backwards compatibility
export const getSignalProtocolService = () => import('./SignalProtocolService').then(m => m.signalProtocolService)
export const getEncryptionKeyStore = () => import('./EncryptionKeyStore').then(m => m.EncryptionKeyStore)
export const getMessageEncryptionService = () => import('./MessageEncryptionService').then(m => m.messageEncryptionService)

// Legacy type exports (for WebRTC only)
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

// Legacy direct exports (for WebRTC backwards compatibility)
export { signalProtocolService } from './SignalProtocolService'
export { EncryptionKeyStore } from './EncryptionKeyStore'
export { messageEncryptionService } from './MessageEncryptionService'


