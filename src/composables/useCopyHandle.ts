import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { isBridgedDiscordProfileUser } from '@/services/bridgedChannelUsersService'
import { formatHandle, type HandleOwner } from '@/utils/handles'

export type CopyHandleAccount = HandleOwner & { id?: string; bridge_source?: string }

/**
 * The handle a person copies to follow or mention an account from anywhere: `@user@domain`,
 * this instance's domain for a local account. '' for a bridged Discord account, whose name
 * no WebFinger answers.
 */
export function copyableHandle(account: CopyHandleAccount | null | undefined): string {
  if (!account || isBridgedDiscordProfileUser(account)) return ''
  return formatHandle(account, { full: true })
}

/** Copies a handle to the clipboard; a toast names what was copied. */
export function useCopyHandle() {
  const { t } = useI18n()
  const toast = useToast()
  return async function copyHandle(handle: string): Promise<boolean> {
    if (!handle) return false
    try {
      await navigator.clipboard.writeText(handle)
      toast.success(t('activitypub.profileA11y.handleCopied', { handle }))
      return true
    } catch {
      toast.error(t('activitypub.profileA11y.handleCopyFailed'))
      return false
    }
  }
}
