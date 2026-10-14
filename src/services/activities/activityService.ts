import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig'
import { extractYouTubeId, isYouTubeUrl, parseYouTubeTime } from '@/utils/embedDetection'

/**
 * Voice channel activities (migration 20261015100004_voice_activities.sql): one shared player
 * per voice channel. Positions are database-clock milliseconds; clients add the offset
 * serverClockOffset() measures.
 */

export type ActivitySource = 'file' | 'url' | 'youtube' | 'soundcloud' | 'spotify'

export interface ActivityItem {
  title?: string
  thumbnail?: string
  duration_ms?: number
  /** file */
  bucket?: string
  path?: string
  mime_type?: string
  file_id?: string
  /** url, soundcloud */
  url?: string
  /** youtube */
  video_id?: string
  /** spotify */
  uri?: string
}

export interface ActivityQueueEntry {
  source: ActivitySource
  item: ActivityItem
  added_by?: string
}

export interface VoiceActivity {
  channel_id: string
  server_id: string
  source: ActivitySource
  item: ActivityItem
  queue: ActivityQueueEntry[]
  playing: boolean
  position_ms: number
  /** Epoch ms, database clock. */
  position_at: number
  rate: number
  controls: 'everyone' | 'host'
  host_id: string | null
  revision: number
  started_at: string
}

export interface ActivityResult {
  activity: VoiceActivity | null
  server_now: number
}

export type ActivityAction =
  | { action: 'play'; position_ms?: number }
  | { action: 'pause'; position_ms?: number }
  | { action: 'seek'; position_ms: number }
  | { action: 'rate'; rate: number }
  | { action: 'next'; revision?: number }
  | { action: 'jump'; index: number }
  | { action: 'enqueue'; source: ActivitySource; item: ActivityItem }
  | { action: 'dequeue'; index: number }
  | { action: 'controls'; mode: 'everyone' | 'host' }

function fail(error: { message: string; code?: string } | null): void {
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
}

function normalize(activity: VoiceActivity | null): VoiceActivity | null {
  if (!activity) return null
  return { ...activity, rate: Number(activity.rate) || 1, position_ms: Number(activity.position_ms) || 0, position_at: Number(activity.position_at) || 0 }
}

export async function getActivity(channelId: string): Promise<ActivityResult> {
  const { data, error } = await supabase.rpc('get_voice_activity', { p_channel: channelId })
  fail(error)
  const result = data as ActivityResult
  return { activity: normalize(result.activity), server_now: Number(result.server_now) }
}

export async function getServerActivities(serverId: string): Promise<VoiceActivity[]> {
  const { data, error } = await supabase.rpc('get_server_voice_activities', { p_server: serverId })
  fail(error)
  return ((data as Array<VoiceActivity | { get_server_voice_activities: VoiceActivity }> | null) ?? [])
    .map((row) => ('get_server_voice_activities' in row ? row.get_server_voice_activities : row))
    .map((a) => normalize(a)!)
}

export async function startActivity(channelId: string, source: ActivitySource, item: ActivityItem): Promise<ActivityResult> {
  const { data, error } = await supabase.rpc('voice_activity_start', { p_channel: channelId, p_source: source, p_item: item })
  fail(error)
  const result = data as ActivityResult
  return { activity: normalize(result.activity), server_now: Number(result.server_now) }
}

export async function controlActivity(channelId: string, change: ActivityAction): Promise<ActivityResult> {
  const { action, ...value } = change
  const { data, error } = await supabase.rpc('voice_activity_control', { p_channel: channelId, p_action: action, p_value: value })
  fail(error)
  const result = data as ActivityResult
  return { activity: normalize(result.activity), server_now: Number(result.server_now) }
}

export async function stopActivity(channelId: string): Promise<void> {
  const { error } = await supabase.rpc('voice_activity_stop', { p_channel: channelId })
  fail(error)
}

/**
 * Database clock minus the local clock, ms: the best of `samples` round trips of server_now,
 * the one with the shortest round trip, halved.
 */
export async function serverClockOffset(samples = 3): Promise<number> {
  let best: { rtt: number; offset: number } | null = null
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now()
    const { data, error } = await supabase.rpc('server_now')
    const t1 = Date.now()
    if (error || typeof data !== 'number' && typeof data !== 'string') continue
    const rtt = t1 - t0
    const offset = Number(data) - (t0 + rtt / 2)
    if (!best || rtt < best.rtt) best = { rtt, offset }
  }
  return best?.offset ?? 0
}

/** Position the activity has reached at database time `serverTime`, ms. */
export function expectedPosition(activity: Pick<VoiceActivity, 'playing' | 'position_ms' | 'position_at' | 'rate'>, serverTime: number): number {
  if (!activity.playing) return activity.position_ms
  return Math.max(0, activity.position_ms + (serverTime - activity.position_at) * activity.rate)
}

const MEDIA_FILE = /\.(mp4|m4v|webm|mov|mkv|ogv|mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i
const AUDIO_FILE = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i

export interface ParsedActivityLink {
  source: Exclude<ActivitySource, 'file'>
  item: ActivityItem
  /** Start offset from the link (YouTube t=), ms. */
  startMs?: number
}

/** The activity a pasted link plays, or null. */
export function parseActivityLink(input: string): ParsedActivityLink | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()

  if (isYouTubeUrl(url) || host === 'music.youtube.com') {
    const id = extractYouTubeId(url)
    if (!id) return null
    const start = parseYouTubeTime(url)
    return { source: 'youtube', item: { video_id: id, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }, ...(start ? { startMs: start * 1000 } : {}) }
  }

  if (host === 'soundcloud.com' || host === 'www.soundcloud.com' || host === 'm.soundcloud.com') {
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2 || !segments.every((s) => /^[A-Za-z0-9_-]+$/.test(s))) return null
    return { source: 'soundcloud', item: { url: `https://soundcloud.com/${segments.join('/')}` } }
  }

  if (host === 'open.spotify.com') {
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0]?.startsWith('intl-')) segments.shift()
    const [type, id] = segments
    if (!type || !id || !['track', 'album', 'playlist', 'episode', 'show'].includes(type) || !/^[A-Za-z0-9]{10,40}$/.test(id)) return null
    return { source: 'spotify', item: { uri: `spotify:${type}:${id}` } }
  }

  if (url.protocol === 'https:' && MEDIA_FILE.test(url.pathname)) {
    const name = decodeURIComponent(url.pathname.split('/').pop() || '')
    return {
      source: 'url',
      item: { url: url.toString(), title: name || undefined, mime_type: AUDIO_FILE.test(url.pathname) ? 'audio/*' : 'video/*' },
    }
  }
  return null
}

/** The item plays sound only: an audio file or a music service. */
export function isListenActivity(source: ActivitySource, item: ActivityItem): boolean {
  if (source === 'soundcloud' || source === 'spotify') return true
  return (item.mime_type ?? '').startsWith('audio/')
}

/** Title and artwork of a link from the instance's link preview, when it can tell. */
export async function fetchLinkDetails(url: string): Promise<{ title?: string; thumbnail?: string }> {
  try {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) return {}
    const response = await fetch(apiUrl('/api/federation/link-preview'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
    })
    if (!response.ok) return {}
    const preview = await response.json() as { title?: string; image?: string; failed?: boolean }
    if (preview.failed) return {}
    return {
      ...(preview.title && preview.title !== url ? { title: preview.title.slice(0, 300) } : {}),
      ...(preview.image?.startsWith('https://') ? { thumbnail: preview.image } : {}),
    }
  } catch {
    return {}
  }
}
