// MAJOR.MINOR.PATCH comparison for release tags (`v1.6.2`) and app versions
// (`1.6.2`). Pre-release and build suffixes are ignored: releases are cut as
// plain x.y.z tags and GitHub's /releases/latest excludes pre-releases.

export type VersionTriple = [number, number, number]

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

export function parseVersion(input: string | null | undefined): VersionTriple | null {
  const m = VERSION_RE.exec((input ?? '').trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

// Sign of (a - b); null when either side does not parse.
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1
}
