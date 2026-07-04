/**
 * Encryption services (Megolm-style, Matrix-inspired).
 *
 * Import lazily - these modules pull in crypto code that must not land in the
 * initial bundle:
 *
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
