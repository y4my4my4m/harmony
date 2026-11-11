import { randomUUID } from 'node:crypto'
import { parseBuffer } from 'music-metadata'
import { supabase } from '../config/supabase.js'

export const SOUND_BUCKET = 'soundboard'
/** Sounds per server; enforce_server_sound_limit raises SOUNDBOARD_FULL at this count. */
export const MAX_SERVER_SOUNDS = 48
/** Discord caps soundboard clips at 512 KB. */
export const MAX_DISCORD_SOUND_BYTES = 524288
export const MAX_SOUND_DURATION_MS = 5200
/** Discord caps clips at 5.2 s; parsers can round a compliant clip a little over, so this much overshoot is clamped. */
export const SOUND_DURATION_TOLERANCE_MS = 100
export const DISCORD_CDN_TIMEOUT_MS = 15_000
export const DISCORD_SOUND_ID = /^[0-9]{1,20}$/

/** CDN URL built from the id alone; no caller-supplied URL is fetched. */
export function discordSoundCdnUrl(discordSoundId: string): string {
  return `https://cdn.discordapp.com/soundboard-sounds/${discordSoundId}`
}

/** Detects the container from its bytes; the response content-type is not trusted. */
export function soundFormat(bytes: Uint8Array): 'mp3' | 'ogg' | null {
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'ogg'
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'mp3'
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3'
  return null
}

/** Clip length in whole milliseconds; throws when the parser cannot tell. */
export async function audioDurationMs(bytes: Uint8Array, format: 'mp3' | 'ogg'): Promise<number> {
  const metadata = await parseBuffer(bytes, { mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/ogg' }, { duration: true })
  const seconds = metadata.format.duration
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) throw new Error('could not read the sound duration')
  return Math.round(seconds * 1000)
}

/**
 * Copies a Discord soundboard clip into the soundboard bucket.
 * Throws on a failed download, an empty or oversize body, an unknown format,
 * a duration outside 1..5300 ms (5201..5300 is clamped to 5200), or a storage error.
 */
export async function storeDiscordSound(
  serverId: string,
  discordSoundId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ storagePath: string; durationMs: number }> {
  const response = await fetchImpl(discordSoundCdnUrl(discordSoundId), { signal: AbortSignal.timeout(DISCORD_CDN_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Discord CDN answered ${response.status}`)
  const declaredBytes = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_DISCORD_SOUND_BYTES) {
    throw new Error(`sound clip is ${declaredBytes} bytes`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DISCORD_SOUND_BYTES) {
    throw new Error(`sound clip is ${bytes.byteLength} bytes`)
  }
  const format = soundFormat(bytes)
  if (!format) throw new Error('sound clip is neither mp3 nor ogg')
  const parsedMs = await audioDurationMs(bytes, format)
  if (parsedMs < 1 || parsedMs > MAX_SOUND_DURATION_MS + SOUND_DURATION_TOLERANCE_MS) {
    throw new Error(`sound clip lasts ${parsedMs} ms`)
  }
  const durationMs = Math.min(parsedMs, MAX_SOUND_DURATION_MS)

  const storagePath = `${serverId}/${randomUUID()}.${format}`
  const { error } = await supabase.storage.from(SOUND_BUCKET).upload(storagePath, Buffer.from(bytes), {
    contentType: format === 'mp3' ? 'audio/mpeg' : 'audio/ogg',
    upsert: false,
    cacheControl: '31536000',
  })
  if (error) throw new Error(`storage upload failed: ${error.message}`)
  return { storagePath, durationMs }
}

/** Best-effort cleanup of a stored clip; logs and never throws. */
export async function removeStoredSound(storagePath: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from(SOUND_BUCKET).remove([storagePath])
    if (error) console.warn(`Removing stored sound ${storagePath} failed: ${error.message}`)
  } catch (error) {
    console.warn(`Removing stored sound ${storagePath} failed:`, error)
  }
}
