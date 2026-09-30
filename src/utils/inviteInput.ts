/**
 * Classifies what a user pasted into "Join with an invite".
 *
 * local:  a code, or a link to /invite/<code> on this origin
 * remote: an http(s) URL on another host, handed to federated discovery
 */
export type ParsedInviteInput =
  | { kind: 'local'; code: string }
  | { kind: 'remote'; url: string }
  | { kind: 'invalid' }

const CODE_RE = /^[A-Za-z0-9_-]{3,64}$/

export function parseInviteInput(raw: string, currentOrigin: string): ParsedInviteInput {
  const value = raw.trim()
  if (!value) return { kind: 'invalid' }

  if (CODE_RE.test(value)) return { kind: 'local', code: value }

  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    return { kind: 'invalid' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'invalid' }

  if (url.origin === currentOrigin) {
    const match = url.pathname.match(/^\/invite\/([A-Za-z0-9_-]{3,64})\/?$/)
    return match ? { kind: 'local', code: match[1] } : { kind: 'invalid' }
  }

  return { kind: 'remote', url: url.toString() }
}
