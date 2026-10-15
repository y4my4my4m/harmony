/**
 * Official players of music services, from a link. The page URL decides the player, so links
 * posted before a provider was known upgrade too; short links resolve through the preview's
 * canonicalUrl and Bandcamp, whose ids are not in its URLs, through the preview's player.
 *
 * Player URLs:
 *   Spotify      https://open.spotify.com/embed/<type>/<id>        type track|album|playlist|episode|show|artist
 *   Apple Music  https://embed.music.apple.com/<country>/<kind>/<slug>/<id>[?i=<track>]
 *   SoundCloud   https://w.soundcloud.com/player/?url=<page url>&...
 *   Deezer       https://widget.deezer.com/widget/dark/<type>/<id>
 *   Tidal        https://embed.tidal.com/<type>s/<id>
 *   Bandcamp     https://bandcamp.com/EmbeddedPlayer/... (from the preview only)
 */

export type MusicProvider = 'spotify' | 'apple-music' | 'soundcloud' | 'deezer' | 'tidal' | 'bandcamp'

export interface MusicEmbed {
  provider: MusicProvider
  /** Player page for an iframe. */
  src: string
  /** Frame height, CSS px. */
  height: number
  /** A single track or episode (compact player). */
  single: boolean
  /** The page the player shows, for "Open". */
  pageUrl: string
}

export interface MusicPreviewHints {
  provider?: string
  canonicalUrl?: string
  player?: { url: string; height?: number }
}

const PLAYER_HOSTS = new Set([
  'open.spotify.com', 'embed.music.apple.com', 'w.soundcloud.com', 'widget.deezer.com',
  'embed.tidal.com', 'bandcamp.com',
])

/** An https URL on a provider player host; anything else is refused. */
export function isMusicPlayerUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && PLAYER_HOSTS.has(url.hostname.toLowerCase()) && !url.username && !url.password
  } catch {
    return false
  }
}

function parse(raw: string | undefined): URL | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

const SPOTIFY_TYPES = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist'])

function spotify(url: URL): MusicEmbed | null {
  const host = url.hostname.toLowerCase()
  if (host !== 'open.spotify.com' && host !== 'play.spotify.com') return null
  const segments = url.pathname.split('/').filter(Boolean)
  // Locale prefix: /intl-ja/track/<id>
  if (segments[0]?.startsWith('intl-')) segments.shift()
  if (segments[0] === 'embed') segments.shift()
  const [type, id] = segments
  if (!type || !id || !SPOTIFY_TYPES.has(type) || !/^[A-Za-z0-9]{10,40}$/.test(id)) return null
  const single = type === 'track' || type === 'episode'
  return {
    provider: 'spotify',
    src: `https://open.spotify.com/embed/${type}/${id}?utm_source=harmony&theme=0`,
    height: single ? 152 : 352,
    single,
    pageUrl: `https://open.spotify.com/${type}/${id}`,
  }
}

const APPLE_KINDS = new Set(['album', 'playlist', 'song', 'music-video', 'station'])

function appleMusic(url: URL): MusicEmbed | null {
  const host = url.hostname.toLowerCase()
  if (host !== 'music.apple.com' && host !== 'embed.music.apple.com') return null
  const segments = url.pathname.split('/').filter(Boolean)
  const [country, kind] = segments
  if (!country || !/^[a-z]{2}$/i.test(country) || !kind || !APPLE_KINDS.has(kind)) return null
  const id = segments[segments.length - 1]
  if (!id || !/^(\d+|pl\.[A-Za-z0-9-]+|ra\.[A-Za-z0-9-]+)$/.test(id)) return null
  const track = url.searchParams.get('i')
  const single = kind === 'song' || (kind === 'album' && !!track && /^\d+$/.test(track))
  const path = segments.map(encodeURIComponent).join('/')
  const query = track && /^\d+$/.test(track) ? `?i=${track}` : ''
  return {
    provider: 'apple-music',
    src: `https://embed.music.apple.com/${path}${query}`,
    height: single ? 175 : kind === 'music-video' ? 360 : 450,
    single,
    pageUrl: `https://music.apple.com/${path}${query}`,
  }
}

function soundcloud(url: URL): MusicEmbed | null {
  const host = url.hostname.toLowerCase()
  if (host !== 'soundcloud.com' && host !== 'www.soundcloud.com' && host !== 'm.soundcloud.com') return null
  const segments = url.pathname.split('/').filter(Boolean)
  // /<user>/<track> or /<user>/sets/<set>
  if (segments.length < 2) return null
  if (['you', 'discover', 'search', 'stream', 'upload', 'pages', 'terms-of-use', 'charts'].includes(segments[0])) return null
  const set = segments[1] === 'sets'
  if (set && segments.length < 3) return null
  if (!segments.every((s) => /^[A-Za-z0-9_-]+$/.test(s))) return null
  const page = `https://soundcloud.com/${segments.slice(0, set ? 3 : 2).join('/')}`
  const params = new URLSearchParams({
    url: page,
    color: '#0ea5e9',
    auto_play: 'false',
    hide_related: 'true',
    show_comments: 'false',
    show_user: 'true',
    show_reposts: 'false',
    show_teaser: 'false',
    visual: 'false',
  })
  return {
    provider: 'soundcloud',
    src: `https://w.soundcloud.com/player/?${params.toString()}`,
    height: set ? 352 : 166,
    single: !set,
    pageUrl: page,
  }
}

const DEEZER_TYPES = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist'])

function deezer(url: URL): MusicEmbed | null {
  const host = url.hostname.toLowerCase()
  if (host !== 'deezer.com' && host !== 'www.deezer.com') return null
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] && /^[a-z]{2}$/.test(segments[0])) segments.shift()
  const [type, id] = segments
  if (!type || !id || !DEEZER_TYPES.has(type) || !/^\d{1,20}$/.test(id)) return null
  const single = type === 'track' || type === 'episode'
  return {
    provider: 'deezer',
    src: `https://widget.deezer.com/widget/dark/${type}/${id}`,
    height: single ? 152 : 340,
    single,
    pageUrl: `https://www.deezer.com/${type}/${id}`,
  }
}

const TIDAL_TYPES = new Set(['track', 'album', 'playlist', 'video'])

function tidal(url: URL): MusicEmbed | null {
  const host = url.hostname.toLowerCase()
  if (host !== 'tidal.com' && host !== 'listen.tidal.com' && host !== 'www.tidal.com') return null
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] === 'browse') segments.shift()
  const [type, id] = segments
  if (!type || !id || !TIDAL_TYPES.has(type) || !/^[A-Za-z0-9-]{1,40}$/.test(id)) return null
  const single = type === 'track'
  return {
    provider: 'tidal',
    src: `https://embed.tidal.com/${type}s/${id}`,
    height: single ? 120 : type === 'video' ? 360 : 400,
    single,
    pageUrl: `https://tidal.com/browse/${type}/${id}`,
  }
}

function fromPlayer(provider: MusicProvider, player: { url: string; height?: number } | undefined, page: string): MusicEmbed | null {
  if (!player || !isMusicPlayerUrl(player.url)) return null
  const height = player.height && player.height >= 80 && player.height <= 720 ? player.height : 120
  return { provider, src: player.url, height, single: height <= 175, pageUrl: page }
}

/** The player for a link, or null when the link names no playable item. */
export function musicEmbedFor(rawUrl: string, hints: MusicPreviewHints = {}): MusicEmbed | null {
  for (const candidate of [rawUrl, hints.canonicalUrl]) {
    const url = parse(candidate)
    if (!url) continue
    const found = spotify(url) ?? appleMusic(url) ?? soundcloud(url) ?? deezer(url) ?? tidal(url)
    if (found) return found
  }
  if (hints.provider === 'bandcamp') return fromPlayer('bandcamp', hints.player, rawUrl)
  if (hints.provider === 'soundcloud' && hints.player) {
    // on.soundcloud.com short links: the oEmbed player names the track.
    const embed = fromPlayer('soundcloud', hints.player, rawUrl)
    return embed ? { ...embed, single: true, height: Math.min(embed.height, 166) } : null
  }
  return null
}

const LABELS: Record<MusicProvider, string> = {
  spotify: 'Spotify',
  'apple-music': 'Apple Music',
  soundcloud: 'SoundCloud',
  deezer: 'Deezer',
  tidal: 'TIDAL',
  bandcamp: 'Bandcamp',
}

export function musicProviderLabel(provider: MusicProvider): string {
  return LABELS[provider]
}

/** Hosts whose links may hold a music item, for links without a server preview. */
export function looksLikeMusicLink(rawUrl: string): boolean {
  const url = parse(rawUrl)
  return !!url && musicEmbedFor(rawUrl) !== null
}
