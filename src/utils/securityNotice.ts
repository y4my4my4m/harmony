/**
 * Text for notifications of type 'security'. data.event is written by
 * public.record_security_notice (migration 20261005400001_account_security.sql); the push
 * text in federation-backend/src/services/pushPolicy.ts (securityNoticeText) mirrors this.
 */

import { describeUserAgent } from '@/utils/userAgent'
import { i18n } from '@/i18n'

export type SecurityEvent =
  | 'new_sign_in'
  | 'mfa_enabled'
  | 'mfa_disabled'
  | 'recovery_code_used'
  | 'recovery_codes_regenerated'
  | 'password_changed'

export interface SecurityNoticeData {
  event?: SecurityEvent | string
  user_agent?: string | null
  ip?: string | null
  reason?: string | null
}

export function securityNoticeText(data: SecurityNoticeData = {}): { title: string; message: string } {
  const t = i18n.global.t
  switch (data.event) {
    case 'new_sign_in': {
      const device = describeUserAgent(data.user_agent).label
      const where = [device, data.ip].filter(Boolean).join(' · ')
      return {
        title: t('security.notice.newSignIn.title'),
        message: where
          ? t('security.notice.newSignIn.messageWithDevice', { where })
          : t('security.notice.newSignIn.message'),
      }
    }
    case 'mfa_enabled':
      return { title: t('security.notice.mfaEnabled.title'), message: t('security.notice.mfaEnabled.message') }
    case 'mfa_disabled':
      return {
        title: t('security.notice.mfaDisabled.title'),
        message: data.reason === 'recovery_code'
          ? t('security.notice.mfaDisabled.messageRecoveryCode')
          : t('security.notice.mfaDisabled.message'),
      }
    case 'recovery_code_used':
      return { title: t('security.notice.recoveryCodeUsed.title'), message: t('security.notice.recoveryCodeUsed.message') }
    case 'recovery_codes_regenerated':
      return { title: t('security.notice.recoveryCodesRegenerated.title'), message: t('security.notice.recoveryCodesRegenerated.message') }
    case 'password_changed':
      return { title: t('security.notice.passwordChanged.title'), message: t('security.notice.passwordChanged.message') }
    default:
      return { title: t('security.notice.default.title'), message: t('security.notice.default.message') }
  }
}
