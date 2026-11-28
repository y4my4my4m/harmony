import { useToast } from 'vue-toastification'
import { i18n } from '@/i18n'
import { getManualInstallInstructions } from '@/utils/pwaUtils'

let toastInstance: ReturnType<typeof useToast> | null = null

function getToast() {
  if (!toastInstance) {
    toastInstance = useToast()
  }
  return toastInstance
}

function showInstallHintToast(key: 'pwa.installUnavailable' | 'pwa.installFailed'): void {
  const hint = getManualInstallInstructions()
  getToast().info(i18n.global.t(key, { hint }), { timeout: 8000 })
}

/**
 * Show install fallback when deferred prompt() is unavailable.
 */
export function showInstallUnavailableToast(): void {
  showInstallHintToast('pwa.installUnavailable')
}

export function showInstallFailedToast(): void {
  showInstallHintToast('pwa.installFailed')
}
