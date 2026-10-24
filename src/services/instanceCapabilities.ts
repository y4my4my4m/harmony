// What the instance behind the native app supports. The web app is served by its instance and
// matches it; the native app is one binary for any instance, which updates only when its admin
// updates it. /instance-info lists capabilities (federation-backend config/capabilities.ts), and
// a feature whose capability is absent stays hidden instead of calling what the server lacks.

import { ref } from 'vue'
import { useToast } from 'vue-toastification'
import { i18n } from '@/i18n'
import { getStoredInstance, isTauriRuntime, refreshStoredInstance, type InstanceConfig } from '@/services/instanceConfig'
import { getBuildInfo } from '@/utils/buildInfo'
import { debug } from '@/utils/debug'

/** The capabilities this app knows; federation-backend config/capabilities.ts lists the server's. */
export const KNOWN_CAPABILITIES = ['encrypted-history', 'outgoing-webhooks'] as const
export type Capability = (typeof KNOWN_CAPABILITIES)[number]

const instance = ref<InstanceConfig | null>(getStoredInstance())
const NOTICE_KEY = 'harmony.instance-version-notice'

/** Every capability on a web page; in the native app, those the stored instance lists. */
export function hasCapability(name: Capability): boolean {
  if (!isTauriRuntime()) return true
  return instance.value?.capabilities?.includes(name) === true
}

/** a is an older release than b, by numeric major.minor.patch; anything else is not. */
export function isOlderVersion(a: string | undefined, b: string | undefined): boolean {
  const parse = (v: string | undefined) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? '')?.slice(1, 4).map(Number) ?? null
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i]
  }
  return false
}

/**
 * Native app start: refreshes the stored instance, then says once per instance version when
 * the instance runs an older release than the app and lacks a capability the app knows: a
 * version gap with nothing hidden says nothing.
 */
export async function checkInstanceVersion(appVersion: string = getBuildInfo().version): Promise<void> {
  if (!isTauriRuntime()) return
  const refreshed = await refreshStoredInstance().catch((err) => {
    debug.warn('Instance info refresh failed:', err)
    return null
  })
  if (refreshed) instance.value = refreshed
  const current = instance.value
  if (!current?.version || !isOlderVersion(current.version, appVersion)) return
  if (KNOWN_CAPABILITIES.every((c) => current.capabilities?.includes(c))) return
  const seen = `${current.origin}@${current.version}`
  try {
    if (localStorage.getItem(NOTICE_KEY) === seen) return
    localStorage.setItem(NOTICE_KEY, seen)
  } catch {
    // Storage refused: the notice may repeat on the next start.
  }
  useToast().info(i18n.global.t('instanceVersion.older', { version: current.version }), { timeout: 12000 })
}
