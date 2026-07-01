import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

/**
 * Lazy refresh of expired bridged (Discord) attachment URLs.
 *
 * Discord CDN URLs are signed and expire (~24h); the `?ex=<hex unix seconds>`
 * query param encodes the expiry. When the instance runs `bridge_attachment_mode
 * = 'refresh'`, viewing a message with an expired URL triggers a request to the
 * bot-gateway, which asks the bridge to re-sign the URLs and silently patch the
 * message. The fresh URL then arrives via the normal realtime message update.
 *
 * Requests are coalesced per message so many expired images (or many viewers)
 * don't fan out into repeated calls.
 */

const COALESCE_MS = 30_000
const EXPIRY_SKEW_MS = 60_000 // refresh slightly before actual expiry
const lastRequestedAt = new Map<string, number>()

export function isDiscordCdnUrl(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.endsWith('discordapp.com') || host.endsWith('discordapp.net')
  } catch {
    return false
  }
}

/** Expiry (ms epoch) encoded in a Discord CDN URL's `ex` param, or null. */
export function discordUrlExpiryMs(url: string): number | null {
  try {
    const ex = new URL(url).searchParams.get('ex')
    if (!ex) return null
    const seconds = parseInt(ex, 16)
    return Number.isFinite(seconds) ? seconds * 1000 : null
  } catch {
    return null
  }
}

export function isExpiredDiscordCdnUrl(url: string | null | undefined): boolean {
  if (!isDiscordCdnUrl(url)) return false
  const expiry = discordUrlExpiryMs(url as string)
  if (expiry == null) return false
  return expiry <= Date.now() + EXPIRY_SKEW_MS
}

/**
 * Any `file` or `url` part whose URL is an expired Discord CDN link.
 * Bridged attachments can arrive as either: proper `file` parts, or inline
 * `url` parts (e.g. a Discord CDN link pasted/echoed into message text). Both
 * render inline media, so both need proactive re-signing.
 */
export function hasExpiredBridgedAttachment(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false
  return parts.some(
    (p: any) =>
      (p?.type === 'file' || p?.type === 'url') && isExpiredDiscordCdnUrl(p?.url),
  )
}

/**
 * Ask the bot-gateway to refresh a message's expired bridged attachment URLs.
 * Fire-and-forget; the updated URLs arrive via realtime. Coalesced per message.
 */
export async function requestAttachmentRefresh(messageId: string | null | undefined): Promise<void> {
  if (!messageId) return

  const now = Date.now()
  const last = lastRequestedAt.get(messageId)
  if (last && now - last < COALESCE_MS) return
  lastRequestedAt.set(messageId, now)

  try {
    const { data: { session } } = await supabase.auth.getSession()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (session?.access_token) headers['Authorization'] = `Bearer ${session.access_token}`

    await fetch('/bot-gateway/attachments/refresh', {
      method: 'POST',
      headers,
      body: JSON.stringify({ messageId }),
    })
  } catch (error) {
    // Best-effort; a failure just means the broken image stays broken for now.
    debug.warn('⚠️ Attachment refresh request failed:', error)
  }
}
