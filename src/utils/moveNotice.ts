/**
 * Text for notifications of type 'move'. data is written by
 * public.migrate_account_followers (migration 20261010900001_account_migration.sql): origin
 * and target handles and follow_status, accepted or pending. The push text in
 * federation-backend/src/services/pushPolicy.ts (moveNoticeText) mirrors this.
 */

import { i18n } from '@/i18n'

interface MovedAccountData {
  username?: string | null
  domain?: string | null
  display_name?: string | null
  is_local?: boolean | null
}

export interface MoveNoticeData {
  origin?: MovedAccountData | null
  target?: MovedAccountData | null
  follow_status?: 'accepted' | 'pending' | string
}

export function moveNoticeHandle(account: MovedAccountData | null | undefined): string | null {
  if (!account?.username) return null
  return account.domain && account.is_local !== true ? `@${account.username}@${account.domain}` : `@${account.username}`
}

export function moveNoticeText(data: MoveNoticeData = {}): { title: string; message: string } {
  const t = i18n.global.t
  const origin = data.origin?.display_name || moveNoticeHandle(data.origin) || t('accountMigration.notice.someone')
  const target = moveNoticeHandle(data.target) || t('accountMigration.notice.newAccount')
  return {
    title: t('accountMigration.notice.title', { origin, target }),
    message: data.follow_status === 'pending'
      ? t('accountMigration.notice.requested', { target })
      : t('accountMigration.notice.following', { target }),
  }
}
