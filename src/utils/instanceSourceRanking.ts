// Instance suggestions for Trending's source filter, ranked from the rows already on screen.

export interface RankablePost {
  author?: { domain?: string | null; is_local?: boolean | null } | null
  replies_count?: number | null
  reblogs_count?: number | null
  favorites_count?: number | null
}

export interface RankablePerson {
  domain?: string | null
  is_local?: boolean | null
}

export interface DomainCount {
  domain: string
  count: number
  /** What `count` counts. */
  kind: 'posts' | 'people'
}

export interface SourceSuggestion {
  domain: string
  group: 'pinned' | 'results' | 'recent'
  count?: number
  kind?: DomainCount['kind']
}

const pow = (value: number | null | undefined, exponent: number): number =>
  Math.pow(Math.max(Number(value) || 0, 0), exponent)

/** get_trending_posts' engagement term (migration 20261005500001), without its time decay. */
export function postEngagement(post: RankablePost): number {
  return pow(post.replies_count, 0.9) * 3 + pow(post.reblogs_count, 0.8) * 2 + pow(post.favorites_count, 0.7)
}

const remoteDomain = (domain: string | null | undefined, isLocal: boolean | null | undefined, local: string): string => {
  if (isLocal) return ''
  const d = (domain || '').trim().toLowerCase()
  return d && d !== local ? d : ''
}

/** Remote author domains: most posts first, then most engagement, then by name. */
export function rankPostDomains(posts: readonly RankablePost[], localDomain?: string | null): DomainCount[] {
  const local = (localDomain || '').toLowerCase()
  const stats = new Map<string, { count: number; engagement: number }>()
  for (const post of posts) {
    const domain = remoteDomain(post.author?.domain, post.author?.is_local, local)
    if (!domain) continue
    const s = stats.get(domain) ?? { count: 0, engagement: 0 }
    s.count += 1
    s.engagement += postEngagement(post)
    stats.set(domain, s)
  }
  return Array.from(stats, ([domain, s]) => ({ domain, ...s }))
    .sort((a, b) => b.count - a.count || b.engagement - a.engagement || a.domain.localeCompare(b.domain))
    .map(({ domain, count }) => ({ domain, count, kind: 'posts' as const }))
}

/** Remote domains of `people`: most accounts first, then the list's own order. */
export function rankPeopleDomains(people: readonly RankablePerson[], localDomain?: string | null): DomainCount[] {
  const local = (localDomain || '').toLowerCase()
  const stats = new Map<string, { count: number; first: number }>()
  people.forEach((person, index) => {
    const domain = remoteDomain(person.domain, person.is_local, local)
    if (!domain) return
    const s = stats.get(domain) ?? { count: 0, first: index }
    s.count += 1
    stats.set(domain, s)
  })
  return Array.from(stats, ([domain, s]) => ({ domain, ...s }))
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .map(({ domain, count }) => ({ domain, count, kind: 'people' as const }))
}

/**
 * At most `limit` suggestions, each domain once: the selected domain, then ranked post
 * domains, then ranked people domains, then recently seen instances.
 */
export function sourceSuggestions(input: {
  selected?: string | null
  posts?: readonly DomainCount[]
  people?: readonly DomainCount[]
  recent?: readonly string[]
  localDomain?: string | null
  limit: number
}): SourceSuggestion[] {
  const local = (input.localDomain || '').toLowerCase()
  const out: SourceSuggestion[] = []
  const seen = new Set<string>()
  const add = (domain: string, entry: Omit<SourceSuggestion, 'domain'>) => {
    const d = domain.trim().toLowerCase()
    if (out.length >= input.limit || !d || d === 'local' || d === local || seen.has(d)) return
    seen.add(d)
    out.push({ domain: d, ...entry })
  }
  if (input.selected) {
    const selected = input.selected.trim().toLowerCase()
    const ranked = [...(input.posts ?? []), ...(input.people ?? [])].find(row => row.domain === selected)
    add(selected, ranked ? { group: 'pinned', count: ranked.count, kind: ranked.kind } : { group: 'pinned' })
  }
  for (const row of input.posts ?? []) add(row.domain, { group: 'results', count: row.count, kind: row.kind })
  for (const row of input.people ?? []) add(row.domain, { group: 'results', count: row.count, kind: row.kind })
  for (const domain of input.recent ?? []) add(domain, { group: 'recent' })
  return out
}

/**
 * Typed text as a domain fragment: scheme, any path and `user@` dropped, then only
 * letters, digits, '.', '-', '_' and ':' kept, so neither '%' nor '*' (PostgREST's
 * alias for '%' in like patterns) reaches a filter.
 */
export function normalizeDomainQuery(text: string): string {
  let q = text.trim().toLowerCase()
  q = q.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  q = q.split(/[/?#\s]/)[0]
  q = q.slice(q.lastIndexOf('@') + 1)
  return q.replace(/[^\p{L}\p{N}._:-]/gu, '')
}

/** `fragment` as an ILIKE pattern matching it anywhere; '\' and '_' escaped (Postgres LIKE default escape). */
export function ilikeContains(fragment: string): string {
  return `%${fragment.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}
