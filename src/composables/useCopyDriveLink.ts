import { useToast } from 'vue-toastification'
import { useT } from '@/composables/useT'
import { driveFileUrl } from '@/services/drive/driveLinks'

/** Copies a file's /drive/file/<id> address and says so. False when the clipboard refused. */
export function useCopyDriveLink(): (fileId: string) => Promise<boolean> {
  const toast = useToast()
  const { t } = useT()
  return async (fileId: string) => {
    try {
      await navigator.clipboard.writeText(driveFileUrl(fileId))
      toast.success(t('drive.toast.linkCopied'))
      return true
    } catch {
      toast.error(t('drive.toast.linkCopyFailed'))
      return false
    }
  }
}
