import { useToast } from 'vue-toastification'
import { useT } from '@/composables/useT'
import { driveTokenUrl } from '@/services/drive/driveLinks'

/** Copies a file's /d/<token> address and says so. False when the clipboard refused. */
export function useCopyDriveLink(): (token: string) => Promise<boolean> {
  const toast = useToast()
  const { t } = useT()
  return async (token: string) => {
    try {
      await navigator.clipboard.writeText(driveTokenUrl(token))
      toast.success(t('drive.toast.linkCopied'))
      return true
    } catch {
      toast.error(t('drive.toast.linkCopyFailed'))
      return false
    }
  }
}
