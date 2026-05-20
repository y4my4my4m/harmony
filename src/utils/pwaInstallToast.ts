import { useToast } from 'vue-toastification'
import { getManualInstallInstructions } from '@/utils/pwaUtils'

let toastInstance: ReturnType<typeof useToast> | null = null

function getToast() {
  if (!toastInstance) {
    toastInstance = useToast()
  }
  return toastInstance
}

/**
 * Show install fallback when deferred prompt() is unavailable.
 */
export function showInstallUnavailableToast(reason?: string): void {
  const toast = getToast()
  const hint = getManualInstallInstructions()
  const message = reason
    ? `${reason} ${hint}`
    : `Install is not available from this page right now. ${hint}`
  toast.info(message, { timeout: 8000 })
}

export function showInstallFailedToast(): void {
  showInstallUnavailableToast('Install was dismissed or could not start.')
}
