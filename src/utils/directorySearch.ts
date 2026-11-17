// Search text of Discover communities: the merged field of Other instances and the collapsible
// controls of both tabs.

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?$`)
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * `host[:port]`, lowercased, when `input` reads as an instance domain or URL; null otherwise.
 * Mirrors normalizeDirectoryDomain (federation-backend services/RemoteDirectoryService.ts), with
 * one deviation: a bare word is text to filter by, so a host needs a dot or a port unless a scheme
 * was typed, and its last label holds a letter unless the whole host is an IPv4 address.
 */
export function instanceDomainFromInput(input: string): string | null {
  let raw = input.trim().toLowerCase()
  if (!raw || raw.length > 260 || /\s/.test(raw)) return null
  const scheme = /^https?:\/\//.test(raw)
  // :443 is the scheme's default port: URL.host leaves it out.
  raw = raw.replace(/^https?:\/\//, '').split(/[/?#]/)[0].replace(/\.$/, '').replace(/:443$/, '')
  if (!HOST.test(raw) || raw.length > 253) return null
  const host = raw.replace(/:\d+$/, '')
  const port = host !== raw
  if (!scheme && !port && !host.includes('.')) return null
  if (host.includes('.') && !IPV4.test(host) && !/[a-z]/.test(host.slice(host.lastIndexOf('.') + 1))) return null
  return raw
}

export interface FilterableServer {
  name: string
  summary?: string | null
  handle?: string | null
  category?: string | null
  instance?: { domain: string; name: string | null }
}

/** NFKC, lowercased, trimmed. Mirrors fold() of federation-backend services/AdvertisedDirectoryService.ts. */
export function foldSearchText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en').trim()
}

/**
 * The folded query is in the server's name, summary, handle, category or instance; an empty query
 * matches all. Mirrors matches() of federation-backend services/AdvertisedDirectoryService.ts, so
 * rows filtered here are the rows the merged list answers for the same text.
 */
export function serverMatchesQuery(server: FilterableServer, query: string): boolean {
  const needle = foldSearchText(query)
  if (!needle) return true
  return foldSearchText([
    server.name, server.summary ?? '', server.handle ?? '', server.category ?? '',
    server.instance?.domain ?? '', server.instance?.name ?? '',
  ].join('\n')).includes(needle)
}

/** Least downward list scroll, in CSS px past the offset the controls opened at, that folds them. */
export const AUTO_COLLAPSE_PX = 64

/**
 * Open controls fold once the list scrolls `threshold` CSS px (the controls' own height, at least
 * AUTO_COLLAPSE_PX) below where they were opened: as far as controls scrolling with the list would
 * have left the screen. Never while a text field in them has focus: folding would hide the field
 * being typed in.
 */
export function shouldAutoCollapse(state: {
  expanded: boolean
  scrollTop: number
  openedAt: number
  typing: boolean
  threshold?: number
}): boolean {
  const threshold = Math.max(AUTO_COLLAPSE_PX, state.threshold ?? 0)
  return state.expanded && !state.typing && state.scrollTop - state.openedAt >= threshold
}
