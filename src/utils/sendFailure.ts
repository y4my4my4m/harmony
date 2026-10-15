import { isModerationRejectionCode } from '@/services/AutoModService'
import { i18n } from '@/i18n'

/**
 * Send rejections that warrant their own feedback:
 *   encryption-required  the channel or DM mandates E2EE; no plaintext override
 *   encryption           other ENCRYPTION_* policy errors
 *   recipient-deleted    the DM recipient's account is gone
 *   slowmode             the chat store rethrows SLOWMODE_ACTIVE as "Slowmode is on ..."
 *   rules                the server requires rules acceptance
 *   moderation           AutoMod block, member timeout, new-account limit
 *   permission           a channel permission refused the content ("Missing permission: NAME")
 */
export type SendFailureKind =
  | 'encryption-required'
  | 'encryption'
  | 'recipient-deleted'
  | 'slowmode'
  | 'rules'
  | 'moderation'
  | 'permission'
  | 'other'

export function classifySendFailure(error: unknown): SendFailureKind {
  const e = error as { code?: unknown; message?: unknown } | null
  const code = (e?.code ?? '').toString()
  const msg = typeof e?.message === 'string' ? e.message : String(error)
  if (code === 'ENCRYPTION_REQUIRED' || msg.includes('ENCRYPTION_REQUIRED')) return 'encryption-required'
  if (code.startsWith('ENCRYPTION_') || msg.includes('ENCRYPTION_')) return 'encryption'
  if (code === 'RECIPIENT_DELETED' || msg.includes('RECIPIENT_DELETED')) return 'recipient-deleted'
  if (msg.includes('Slowmode')) return 'slowmode'
  if (code === 'RULES_NOT_ACCEPTED' || msg.includes('RULES_NOT_ACCEPTED')) return 'rules'
  if (isModerationRejectionCode(code)) return 'moderation'
  if (msg.includes('Missing permission:')) return 'permission'
  return 'other'
}

/** The permission a 'permission' failure names, e.g. USE_EXTERNAL_EMOJIS; null for any other. */
export function refusedPermission(error: unknown): string | null {
  const e = error as { message?: unknown } | null
  const msg = typeof e?.message === 'string' ? e.message : String(error)
  return msg.match(/Missing permission: ([A-Z_]+)/)?.[1] ?? null
}

/** The notice for a 'permission' failure: the external emoji rule in words, else the server's text. */
export function permissionRefusalMessage(error: unknown): string {
  if (refusedPermission(error) === 'USE_EXTERNAL_EMOJIS') return i18n.global.t('emoji.externalNotAllowed')
  const e = error as { message?: unknown } | null
  return typeof e?.message === 'string' ? e.message : String(error)
}
