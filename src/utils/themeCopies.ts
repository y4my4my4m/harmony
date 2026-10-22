// The visual theme is stored twice: on the device (localStorage, written at once) and on
// the profile (profiles.appearance_settings, written after a debounce). Both copies carry
// SAVED_AT_KEY, Date.now() of the change they hold. At load the device copy wins only when
// it is newer than a stamped profile copy, so a reload before the profile write lands keeps
// the device's theme. A profile copy without the key comes from a client that does not
// stamp, possibly after this device's change, and wins; so does the profile copy on a tie.

export const SAVED_AT_KEY = 'savedAt'

export function savedAtOf(copy: unknown): number {
  const at = copy && typeof copy === 'object' ? (copy as Record<string, unknown>)[SAVED_AT_KEY] : undefined
  return typeof at === 'number' && Number.isFinite(at) ? at : 0
}

export function stampCopy<T extends object>(settings: T, at: number = Date.now()): T & { savedAt: number } {
  return { ...settings, [SAVED_AT_KEY]: at } as T & { savedAt: number }
}

/** `copy` without its timestamp; the live settings never carry one. */
export function withoutStamp<T extends object>(copy: T): T {
  const { [SAVED_AT_KEY]: _at, ...rest } = copy as Record<string, unknown>
  return rest as T
}

/** Which copy to load; null when there is none. */
export function newerCopy(local: unknown, remote: unknown): 'local' | 'remote' | null {
  if (!remote) return local ? 'local' : null
  if (!local) return 'remote'
  const remoteAt = savedAtOf(remote)
  return remoteAt > 0 && savedAtOf(local) > remoteAt ? 'local' : 'remote'
}
