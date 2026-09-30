export const SERVER_CATEGORIES = [
  'Gaming',
  'Technology',
  'Art & Design',
  'Music',
  'Education',
  'Entertainment',
  'Community',
  'Science',
  'Sports',
  'Other',
] as const

export type ServerCategory = (typeof SERVER_CATEGORIES)[number]

const CATEGORY_LABEL_KEYS: Record<ServerCategory, string> = {
  'Gaming': 'server.categoryGaming',
  'Technology': 'server.categoryTechnology',
  'Art & Design': 'server.categoryArtDesign',
  'Music': 'server.categoryMusic',
  'Education': 'server.categoryEducation',
  'Entertainment': 'server.categoryEntertainment',
  'Community': 'server.categoryCommunity',
  'Science': 'server.categoryScience',
  'Sports': 'server.categorySports',
  'Other': 'server.categoryOther',
}

export function categoryLabelKey(category: string): string | null {
  return CATEGORY_LABEL_KEYS[category as ServerCategory] ?? null
}

// Whole-word keywords, checked in order; the first category with a hit wins.
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [ServerCategory, readonly string[]]> = [
  ['Gaming', [
    'game', 'games', 'gaming', 'gamer', 'gamers', 'minecraft', 'fortnite', 'valorant',
    'steam', 'esports', 'rpg', 'mmo', 'mmorpg', 'speedrun', 'speedrunning', 'nintendo',
    'playstation', 'xbox',
  ]],
  ['Technology', [
    'tech', 'technology', 'programming', 'programmer', 'programmers', 'code', 'coding',
    'coder', 'coders', 'developer', 'developers', 'dev', 'devs', 'software', 'linux',
    'opensource', 'ai', 'ml', 'crypto', 'blockchain', 'selfhosted', 'selfhosting',
    'homelab', 'javascript', 'typescript', 'python',
  ]],
  ['Art & Design', [
    'art', 'arts', 'artist', 'artists', 'design', 'designer', 'designers', 'drawing',
    'illustration', 'painting', 'graphics', 'pixelart', 'animation', 'creative',
    'photography',
  ]],
  ['Music', [
    'music', 'musician', 'musicians', 'band', 'bands', 'song', 'songs', 'songwriting',
    'producer', 'producers', 'beats', 'dj', 'guitar', 'piano', 'jazz', 'hiphop',
  ]],
  ['Education', [
    'school', 'study', 'studying', 'learn', 'learning', 'education', 'homework',
    'university', 'college', 'student', 'students', 'tutoring', 'course', 'courses',
  ]],
  ['Entertainment', [
    'movie', 'movies', 'film', 'films', 'tv', 'anime', 'manga', 'meme', 'memes',
    'podcast', 'podcasts', 'comics', 'streamer', 'streamers',
  ]],
  ['Community', [
    'community', 'social', 'friends', 'hangout', 'lounge', 'meetup',
  ]],
  ['Science', [
    'science', 'research', 'physics', 'chemistry', 'biology', 'math', 'maths',
    'mathematics', 'astronomy', 'engineering',
  ]],
  ['Sports', [
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
  return 'Other'
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
