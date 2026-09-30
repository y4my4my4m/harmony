/**
 * Channel encryption send failures as a window event: a setup or unlock prompt for a sender who
 * cannot encrypt, a toast otherwise.
 */
import { isChannelEncryptionError } from '@/services/core/channelMessageEncryption'

export const ENCRYPTION_ACTION_EVENT = 'harmony:encryption-action'
/** Fired after keys are set up or unlocked. */
export const ENCRYPTION_STATE_CHANGED_EVENT = 'harmony:encryption-state-changed'

export interface EncryptionActionDetail {
  reason: string
  message: string
}

/** Returns true when `error` was a channel encryption failure and has been reported. */
export function reportChannelEncryptionError(error: unknown): boolean {
  if (!isChannelEncryptionError(error) || typeof window === 'undefined') return false
  const detail: EncryptionActionDetail = { reason: error.reason, message: error.message }
  window.dispatchEvent(new CustomEvent(ENCRYPTION_ACTION_EVENT, { detail }))
  return true
}
