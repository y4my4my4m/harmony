/** Matrix identity stays external: never interpret an MXID as a Harmony profile id. */
export function parseMatrixId(id: unknown): { id: string; username: string; domain: string } | null {
  // eslint-disable-next-line no-control-regex -- Matrix ids cannot contain C0/DEL controls.
  if (typeof id !== 'string' || id.length > 255 || /[\u0000-\u001f\u007f]/.test(id)) return null
  const match = /^@([^:\s<>]+):([^\s/\\<>?#%@]+)$/.exec(id)
  if (!match || match[2].endsWith(':')) return null
  try {
    const server = new URL(`https://${match[2]}`)
    if (!server.hostname || server.username || server.password || server.pathname !== '/') return null
  } catch { return null }
  return { id, username: match[1], domain: match[2] }
}

export function isMatrixMention(part: { bridgeSource?: unknown; userId?: unknown } | null | undefined): boolean {
  return part?.bridgeSource === 'matrix' || !!parseMatrixId(part?.userId)
}

/** One URI-encoded field avoids MXID colons and token delimiter collisions. */
export function matrixMentionToken(id: string): string | null {
  return parseMatrixId(id) ? `<@matrix:${encodeURIComponent(id)}>` : null
}

export function parseMatrixMentionToken(token: string): ReturnType<typeof parseMatrixId> {
  const match = /^<@matrix:([^<>\s:]*)>$/.exec(token)
  if (!match) return null
  try {
    const id = decodeURIComponent(match[1])
    if (encodeURIComponent(id) !== match[1]) return null
    return parseMatrixId(id)
  } catch { return null }
}

export function matrixProfileUrl(id: string): string | null {
  return parseMatrixId(id) ? `https://matrix.to/#/${encodeURIComponent(id)}` : null
}
