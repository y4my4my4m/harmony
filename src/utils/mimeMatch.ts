/**
 * Bucket MIME allowlists as storage-api reads them: an entry is an exact type or a
 * `type/*` wildcard; parameters (`;codecs=opus`) and case are ignored.
 */
export function mimeAllowed(allowed: readonly string[] | null | undefined, type: string): boolean {
  if (!allowed || allowed.length === 0) return true
  const base = type.split(';')[0].trim().toLowerCase()
  if (!base) return false
  const major = base.split('/')[0]
  return allowed.some(entry => {
    const e = entry.trim().toLowerCase()
    return e === base || e === '*/*' || (e.endsWith('/*') && e.slice(0, -2) === major)
  })
}
