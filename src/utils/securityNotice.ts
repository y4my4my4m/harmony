/**
 * Text for notifications of type 'security'. data.event is written by
 * public.record_security_notice (migration 20261005400001_account_security.sql); the push
 * text in federation-backend/src/services/pushPolicy.ts (securityNoticeText) mirrors this.
 */

import { describeUserAgent } from '@/utils/userAgent'

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
  switch (data.event) {
    case 'new_sign_in': {
      const device = describeUserAgent(data.user_agent).label
      const where = [device, data.ip].filter(Boolean).join(' · ')
      return {
        title: 'New sign-in to your account',
        message: `${where ? `${where}. ` : ''}Not you? Change your password and sign that session out.`,
      }
    }
    case 'mfa_enabled':
      return { title: 'Two-factor authentication turned on', message: 'Sign-ins now need your authenticator.' }
    case 'mfa_disabled':
      return {
        title: 'Two-factor authentication turned off',
        message: data.reason === 'recovery_code'
          ? 'A recovery code was used to sign in. Set up two-factor authentication again.'
          : 'Your account no longer asks for an authenticator code.',
      }
    case 'recovery_code_used':
      return { title: 'Recovery code used', message: 'One of your recovery codes was used.' }
    case 'recovery_codes_regenerated':
      return { title: 'New recovery codes', message: 'Your previous recovery codes no longer work.' }
    case 'password_changed':
      return { title: 'Password changed', message: 'Your password was changed and your other sessions were signed out.' }
    default:
      return { title: 'Account security', message: 'There was a change to your account security.' }
  }
}
