/**
 * Re-signs expired Discord attachment links in a message with the instance Discord application's
 * bot token, for messages no connected bot can refresh: a link a person pasted, or a bridged
 * message whose bridge is offline. Discord's `POST /attachments/refresh-urls` takes the URLs alone,
 * with no channel or message; a URL it does not answer for leaves the message as it is.
 *
 * Requests from several messages share one Discord call (at most REFRESH_URLS_MAX URLs), so a
 * channel scrolled past makes a call per batch, not per message.
 */

import { DISCORD_API_BASE } from './instanceBot.js'

/** Discord's limit on `attachment_urls` per refresh-urls call. */
export const REFRESH_URLS_MAX = 50

/** src/services/attachmentRefresh.ts EXPIRY_SKEW_MS: a link this close to expiry counts as expired. */
const EXPIRY_SKEW_MS = 60_000

const BATCH_DELAY_MS = 250
const CALLS_PER_MINUTE = 60
/** Messages of one author admitted a minute: links that never sign cannot take the shared budget. */
const AUTHOR_MESSAGES_PER_MINUTE = 30
const AUTHORS_MAX = 10_000
const TOKEN_TTL_MS = 60_000
/** A message whose links Discord did not re-sign (attachment deleted, token refused) waits this long. */
const FAILED_TTL_MS = 10 * 60_000
const FAILED_MAX = 10_000
const FETCH_TIMEOUT_MS = 10_000

const ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])
const ATTACHMENT_PATH = /^\/(?:ephemeral-)?attachments\/\d{1,20}\/\d{1,20}\/[^/]+$/

function attachmentUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !ATTACHMENT_HOSTS.has(url.hostname) || !ATTACHMENT_PATH.test(url.pathname)) {
    return null
  }
  return url
}

/** Host and path: one attachment, whatever signature its query carries. */
function attachmentKey(url: URL): string {
  return `${url.hostname}${url.pathname}`
}

/**
 * `ex` is the expiry in hexadecimal unix seconds. A link without it predates signed links
 * (December 2023) and no longer loads, so it needs signing too.
 */
function needsSigning(url: URL, nowMs: number): boolean {
  const ex = url.searchParams.get('ex')
  if (!ex || !/^[0-9a-f]{1,12}$/i.test(ex)) return true
  return parseInt(ex, 16) * 1000 <= nowMs + EXPIRY_SKEW_MS
}

type Part = Record<string, unknown>

function linkParts(content: unknown): Part[] {
  if (!Array.isArray(content)) return []
  return content.filter(
    (p): p is Part => !!p && typeof p === 'object' && ((p as Part).type === 'file' || (p as Part).type === 'url'),
  )
}

/** Distinct `url`s of the message's file and url parts that are Discord attachment links due for signing. */
export function expiredDiscordAttachmentUrls(content: unknown, nowMs: number): string[] {
  const urls = new Set<string>()
  for (const part of linkParts(content)) {
    const url = attachmentUrl(part.url)
    if (url && needsSigning(url, nowMs)) urls.add(part.url as string)
    if (urls.size === REFRESH_URLS_MAX) break
  }
  return [...urls]
}

export type RefreshResult =
  | { ok: true; signed: Map<string, string> }
  | { ok: false; status: number; retryAfterMs?: number }

/**
 * One `POST /attachments/refresh-urls` call. `signed` maps attachmentKey to the new URL; an answer
 * for another host or path, or without `ex`, is dropped.
 */
export async function refreshDiscordAttachmentUrls(
  urls: string[],
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshResult> {
  let response: Response
  try {
    response = await fetchImpl(`${DISCORD_API_BASE}/attachments/refresh-urls`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachment_urls: urls }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, status: 0 }
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}

  if (response.status === 429) {
    // retry_after: seconds, fractional.
    const seconds = typeof body.retry_after === 'number' && body.retry_after > 0 ? body.retry_after : 5
    return { ok: false, status: 429, retryAfterMs: Math.ceil(seconds * 1000) }
  }
  if (!response.ok) return { ok: false, status: response.status }

  const asked = new Set(urls.map((u) => attachmentUrl(u)).filter((u): u is URL => !!u).map(attachmentKey))
  const signed = new Map<string, string>()
  for (const entry of Array.isArray(body.refreshed_urls) ? body.refreshed_urls : []) {
    const original = attachmentUrl((entry as Part)?.original)
    const fresh = attachmentUrl((entry as Part)?.refreshed)
    if (!original || !fresh || !fresh.searchParams.get('ex')) continue
    const key = attachmentKey(original)
    if (!asked.has(key) || attachmentKey(fresh) !== key) continue
    signed.set(key, fresh.toString())
  }
  return { ok: true, signed }
}

/** `content` with each signed link's `url` replaced, every other field kept; null when nothing changed. */
export function withSignedUrls(content: unknown, signed: Map<string, string>): unknown[] | null {
  if (!Array.isArray(content)) return null
  let changed = false
  const next = content.map((part) => {
    if (!part || typeof part !== 'object') return part
    const p = part as Part
    if (p.type !== 'file' && p.type !== 'url') return part
    const url = attachmentUrl(p.url)
    const fresh = url ? signed.get(attachmentKey(url)) : undefined
    if (!fresh || fresh === p.url) return part
    changed = true
    return { ...p, url: fresh }
  })
  return changed ? next : null
}

export interface LinkRefreshDeps {
  /** The instance Discord application's bot token; null while the instance bot is off or unconfigured. */
  token: () => Promise<string | null>
  /** update_message_content_silent: false when the content changed after it was read. */
  write: (messageId: string, oldContent: unknown, content: unknown[]) => Promise<boolean>
  fetchImpl?: typeof fetch
  now?: () => number
  log?: Pick<Console, 'info' | 'warn' | 'error'>
}

export type Admission = 'queued' | 'no_signer' | 'busy' | 'failed_recently'

interface Pending {
  messageId: string
  content: unknown
  urls: string[]
}

export class DiscordLinkRefresher {
  private readonly now: () => number
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>
  /** Message id -> time it may be tried again; insertion order is age order. */
  private readonly failedUntil = new Map<string, number>()
  private pending: Pending[] = []
  /** Messages of the batches sent and not yet written: a request for one waits on that batch. */
  private readonly signing = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> = Promise.resolve()
  private pausedUntil = 0
  private calls: number[] = []
  /** Author -> admission times within the last minute. */
  private readonly admitted = new Map<string, number[]>()
  private cachedToken: { value: string | null; until: number } | null = null

  constructor(private readonly deps: LinkRefreshDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? console
  }

  /**
   * Queues the message's expired links (from expiredDiscordAttachmentUrls) for signing. `author`
   * names the message's writer, a user or a bot.
   */
  async request(messageId: string, content: unknown, urls: string[], author?: string | null): Promise<Admission> {
    const now = this.now()
    const until = this.failedUntil.get(messageId)
    if (until !== undefined) {
      if (now < until) return 'failed_recently'
      this.failedUntil.delete(messageId)
    }
    this.calls = this.calls.filter((t) => t > now - 60_000)
    if (now < this.pausedUntil || this.calls.length >= CALLS_PER_MINUTE) return 'busy'
    if (!(await this.token())) return 'no_signer'
    if (this.signing.has(messageId) || this.pending.some((p) => p.messageId === messageId)) return 'queued'
    if (author && !this.admitAuthor(author, now)) return 'busy'

    this.pending.push({ messageId, content, urls: urls.slice(0, REFRESH_URLS_MAX) })
    if (this.pendingUrlCount() >= REFRESH_URLS_MAX) this.flush()
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), BATCH_DELAY_MS)
      this.timer.unref?.()
    }
    return 'queued'
  }

  /** Sends what is queued and waits for every call and write in flight. */
  async drain(): Promise<void> {
    while (this.pending.length > 0) this.flush()
    await this.inFlight
  }

  private admitAuthor(author: string, now: number): boolean {
    const recent = (this.admitted.get(author) ?? []).filter((t) => t > now - 60_000)
    if (recent.length >= AUTHOR_MESSAGES_PER_MINUTE) {
      this.admitted.set(author, recent)
      return false
    }
    if (!this.admitted.has(author) && this.admitted.size >= AUTHORS_MAX) {
      for (const [key, times] of this.admitted) {
        if (times.every((t) => t <= now - 60_000)) this.admitted.delete(key)
      }
      if (this.admitted.size >= AUTHORS_MAX) return false
    }
    recent.push(now)
    this.admitted.set(author, recent)
    return true
  }

  private markFailed(messageId: string): void {
    this.failedUntil.delete(messageId)
    if (this.failedUntil.size >= FAILED_MAX) {
      this.failedUntil.delete(this.failedUntil.keys().next().value as string)
    }
    this.failedUntil.set(messageId, this.now() + FAILED_TTL_MS)
  }

  private pendingUrlCount(): number {
    return this.pending.reduce((n, p) => n + p.urls.length, 0)
  }

  private async token(): Promise<string | null> {
    const now = this.now()
    if (this.cachedToken && now < this.cachedToken.until) return this.cachedToken.value
    let value: string | null = null
    try {
      value = await this.deps.token()
    } catch (error) {
      this.log.error('Instance Discord token lookup failed:', error)
    }
    this.cachedToken = { value, until: now + TOKEN_TTL_MS }
    return value
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const batch: Pending[] = []
    let count = 0
    while (this.pending.length > 0 && count + this.pending[0].urls.length <= REFRESH_URLS_MAX) {
      const next = this.pending.shift() as Pending
      batch.push(next)
      count += next.urls.length
    }
    if (this.pending.length > 0 && !this.timer) {
      this.timer = setTimeout(() => this.flush(), BATCH_DELAY_MS)
      this.timer.unref?.()
    }
    if (batch.length === 0) return
    this.calls.push(this.now())
    for (const p of batch) this.signing.add(p.messageId)
    this.inFlight = this.inFlight
      .then(() => this.sign(batch))
      .catch((error) => this.log.error('Re-signing Discord links failed:', error))
      .finally(() => {
        for (const p of batch) this.signing.delete(p.messageId)
      })
  }

  private async sign(batch: Pending[]): Promise<void> {
    const token = await this.token()
    if (!token) return
    const urls = [...new Set(batch.flatMap((p) => p.urls))]
    const result = await refreshDiscordAttachmentUrls(urls, token, this.deps.fetchImpl)

    if (!result.ok) {
      if (result.status === 429) {
        this.pausedUntil = this.now() + (result.retryAfterMs ?? 5_000)
        return
      }
      if (result.status === 401) this.cachedToken = null
      this.log.warn(`Discord refresh-urls answered ${result.status || 'no response'}; ${batch.length} message(s) wait ${FAILED_TTL_MS / 60_000} min`)
      for (const p of batch) this.markFailed(p.messageId)
      return
    }

    for (const p of batch) {
      const content = withSignedUrls(p.content, result.signed)
      if (!content) {
        this.markFailed(p.messageId)
        continue
      }
      try {
        if (await this.deps.write(p.messageId, p.content, content)) {
          this.log.info(`Re-signed expired Discord links of message ${p.messageId}`)
        }
      } catch (error) {
        this.log.error(`Writing re-signed links of message ${p.messageId} failed:`, error)
      }
    }
  }
}
