import { isModerationRejectionCode } from '@/services/AutoModService'

/**
 * Send rejections that warrant their own feedback:
 *   encryption-required  the channel or DM mandates E2EE; no plaintext override
 *   encryption           other ENCRYPTION_* policy errors
 *   recipient-deleted    the DM recipient's account is gone
 *   slowmode             the chat store rethrows SLOWMODE_ACTIVE as "Slowmode is on ..."
 *   rules                the server requires rules acceptance
 *   moderation           AutoMod block, member timeout, new-account limit
 */
export type SendFailureKind =
  | 'encryption-required'
  | 'encryption'
  | 'recipient-deleted'
  | 'slowmode'
  | 'rules'
  | 'moderation'
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
  return 'other'
}
