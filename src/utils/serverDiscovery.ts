// Ids are stored in servers.category. servers_category_check
// (db_schema/migrations/20261006400001_server_category.sql) mirrors this list.
export const SERVER_CATEGORIES = [
  'gaming',
  'technology',
  'art_design',
  'music',
  'education',
  'entertainment',
  'community',
  'science',
  'sports',
  'other',
] as const

export type ServerCategory = (typeof SERVER_CATEGORIES)[number]

// Icon names resolve through components/common/Icon.vue.
const CATEGORY_META: Record<ServerCategory, { labelKey: string; icon: string }> = {
  gaming: { labelKey: 'server.categoryGaming', icon: 'gamepad' },
  technology: { labelKey: 'server.categoryTechnology', icon: 'cpu' },
  art_design: { labelKey: 'server.categoryArtDesign', icon: 'palette' },
  music: { labelKey: 'server.categoryMusic', icon: 'music' },
  education: { labelKey: 'server.categoryEducation', icon: 'graduation-cap' },
  entertainment: { labelKey: 'server.categoryEntertainment', icon: 'clapperboard' },
  community: { labelKey: 'server.categoryCommunity', icon: 'users' },
  science: { labelKey: 'server.categoryScience', icon: 'flask' },
  sports: { labelKey: 'server.categorySports', icon: 'trophy' },
  other: { labelKey: 'server.categoryOther', icon: 'shapes' },
}

export function isServerCategory(value: unknown): value is ServerCategory {
  return typeof value === 'string' && (SERVER_CATEGORIES as readonly string[]).includes(value)
}

export function categoryLabelKey(category: string): string | null {
  return isServerCategory(category) ? CATEGORY_META[category].labelKey : null
}

export function categoryIcon(category: string): string | null {
  return isServerCategory(category) ? CATEGORY_META[category].icon : null
}

// Whole-word keywords, checked in order; the first category with a hit wins.
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [ServerCategory, readonly string[]]> = [
  ['gaming', [
    'game', 'games', 'gaming', 'gamer', 'gamers', 'minecraft', 'fortnite', 'valorant',
    'steam', 'esports', 'rpg', 'mmo', 'mmorpg', 'speedrun', 'speedrunning', 'nintendo',
    'playstation', 'xbox',
  ]],
  ['technology', [
    'tech', 'technology', 'programming', 'programmer', 'programmers', 'code', 'coding',
    'coder', 'coders', 'developer', 'developers', 'dev', 'devs', 'software', 'linux',
    'opensource', 'ai', 'ml', 'crypto', 'blockchain', 'selfhosted', 'selfhosting',
    'homelab', 'javascript', 'typescript', 'python',
  ]],
  ['art_design', [
    'art', 'arts', 'artist', 'artists', 'design', 'designer', 'designers', 'drawing',
    'illustration', 'painting', 'graphics', 'pixelart', 'animation', 'creative',
    'photography',
  ]],
  ['music', [
    'music', 'musician', 'musicians', 'band', 'bands', 'song', 'songs', 'songwriting',
    'producer', 'producers', 'beats', 'dj', 'guitar', 'piano', 'jazz', 'hiphop',
  ]],
  ['education', [
    'school', 'study', 'studying', 'learn', 'learning', 'education', 'homework',
    'university', 'college', 'student', 'students', 'tutoring', 'course', 'courses',
  ]],
  ['entertainment', [
    'movie', 'movies', 'film', 'films', 'tv', 'anime', 'manga', 'meme', 'memes',
    'podcast', 'podcasts', 'comics', 'streamer', 'streamers',
  ]],
  ['community', [
    'community', 'social', 'friends', 'hangout', 'lounge', 'meetup',
  ]],
  ['science', [
    'science', 'research', 'physics', 'chemistry', 'biology', 'math', 'maths',
    'mathematics', 'astronomy', 'engineering',
  ]],
  ['sports', [
    'sport', 'sports', 'football', 'basketball', 'soccer', 'baseball', 'hockey',
    'tennis', 'fitness', 'workout', 'gym', 'cycling', 'climbing',
  ]],
]

export function inferServerCategory(name: string, description?: string | null): ServerCategory {
  const words = new Set(
    `${name} ${description ?? ''}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
  )
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some(keyword => words.has(keyword))) return category
  }
  return 'other'
}

export interface CategorizedServer {
  name: string
  description?: string | null
  category?: string | null
  is_local_server?: boolean | null
}

/**
 * The owner's choice when it is a known id on a local server; otherwise inferred from
 * name and description. A remote row's category is not read.
 */
export function resolveServerCategory(server: CategorizedServer): ServerCategory {
  if (server.is_local_server !== false && isServerCategory(server.category)) return server.category
  return inferServerCategory(server.name, server.description)
}

export const MAX_SEARCH_TERM_LENGTH = 100

export function normalizeSearchTerm(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_TERM_LENGTH)
}

// Backslash is the default LIKE escape character in PostgreSQL.
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, c => `\\${c}`)
}

/**
 * PostgREST `or` filter: case-insensitive substring match on name or description.
 * Values are double-quoted so `,` `.` `:` `(` `)` in the term stay data; inside
 * quotes `"` and `\` are backslash-escaped. PostgREST rewrites `*` to `%` in like
 * patterns and has no escape for it, so `*` becomes the single-character wildcard.
 */
export function buildServerSearchFilter(raw: string): string | null {
  const term = normalizeSearchTerm(raw)
  if (!term) return null
  const pattern = `%${escapeLikePattern(term).replace(/\*/g, '_')}%`
  const quoted = `"${pattern.replace(/["\\]/g, c => `\\${c}`)}"`
  return `name.ilike.${quoted},description.ilike.${quoted}`
}
