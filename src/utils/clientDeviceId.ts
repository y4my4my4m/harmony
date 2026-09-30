/**
 * Per-tab id for device_view_contexts. sessionStorage survives reloads of the tab
 * and is not shared with other tabs, so two tabs never overwrite each other's view.
 */

const KEY = 'harmony.view-device-id'
let memo: string | null = null

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export function getClientDeviceId(): string {
  if (memo) return memo
  try {
    memo = sessionStorage.getItem(KEY)
    if (!memo) {
      memo = randomId()
      sessionStorage.setItem(KEY, memo)
    }
  } catch {
    memo = memo || randomId()
  }
  return memo
}
