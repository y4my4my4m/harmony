/**
 * The sender's notice that a message went out while its session key reached not every member
 * (MegolmEncryptedMessageData.key_share_failures). Such a member reads the message once a member
 * holding the key answers their key request.
 */
import { i18n } from '@/i18n'
import { debug } from '@/utils/debug'

export function noticeKeyShareFailures(count: number | undefined): void {
  if (!count || count <= 0) return
  void import('@/stores/useNotification')
    .then(({ useNotificationStore }) => {
      useNotificationStore().showToast(
        'server_update',
        i18n.global.t('encryption.keyShareFailed.title'),
        i18n.global.t('encryption.keyShareFailed.body', { count }, count),
        10000,
      )
    })
    .catch(error => debug.warn('Key share notice failed:', error))
}
