import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocketGateway } from '../gateway/WebSocketGateway.js'
import { GoneError, needsDiscordResign, OverQuotaError, TooLargeError, type mirrorFileToStorage } from '../utils/mirrorFile.js'
import { isAllowedSourceUrl, toMirroredPart, type BridgeAttachmentMode } from '../utils/mirrorExternalMedia.js'
import { isDatabaseRefusal } from './mirrorEnqueue.js'

const LEASE_SECONDS = 1800
const BACKFILL_BATCH = 500
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200]
const MAX_ATTEMPTS = 5
const REFRESH_RETRY_SECONDS = 120
const OFFLINE_RETRY_SECONDS = 900
const CONFLICT_RETRY_SECONDS = 60

export interface MirrorWorkerDeps {
  /** Rejects with the PostgREST error's `code` on the Error it throws. */
  rpc(name: string, args: object): Promise<any>
  readMessage(
    id: string,
  ): Promise<{ id: string; content: any[]; channel_id: string; bot_id: string; is_deleted?: boolean | null } | null>
  /** Rejects when the mode cannot be read: a failed read is no change of mode. */
  mode(): Promise<BridgeAttachmentMode>
  ceiling(): Promise<number>
  mirror: typeof mirrorFileToStorage
  /** Removes from storage the objects among `paths` that no message references. */
  discard(paths: string[]): Promise<unknown>
  gateway: Pick<WebSocketGateway, 'isBotConnected' | 'sendToBot'>
  now(): number
  log: Pick<Console, 'info' | 'warn' | 'error'>
}

interface Uploaded {
  index: number
  baseUrl: string
  mirrored: { path: string; url: string; contentType: string; bytes: number }
}

/** A URL without its query: Discord re-signs links, the file stays the same. */
function baseUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.origin + u.pathname
  } catch {
    return url
  }
}

function isCandidate(part: any): boolean {
  return (
    (part?.type === 'file' || part?.type === 'url') &&
    typeof part.url === 'string' &&
    !part.path &&
    isAllowedSourceUrl(part.url)
  )
}

/**
 * Removes mirror-* temp dirs older than `olderThanMs`: leftovers of a gateway that was killed
 * mid-download. Best effort; returns how many were removed.
 */
export async function sweepMirrorTemp(
  dir: string,
  olderThanMs: number,
  now: number,
  log: Pick<Console, 'info' | 'warn'>,
): Promise<number> {
  let removed = 0
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error: any) {
    log.warn('Mirror temp sweep could not read', dir, error?.message || error)
    return 0
  }
  for (const name of names) {
    if (!name.startsWith('mirror-')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (!info.isDirectory() || now - info.mtimeMs <= olderThanMs) continue
      await rm(path, { recursive: true, force: true })
      removed++
    } catch (error: any) {
      log.warn('Mirror temp sweep could not remove', path, error?.message || error)
    }
  }
  if (removed > 0) log.info(`Mirror temp sweep removed ${removed} stale download folder(s) from ${dir}`)
  return removed
}

/**
 * Stores Discord attachments into Harmony storage in the background (mirror mode): messages
 * queued by the bridge or found by the backfill walk. One message per tick; the Discord link
 * stays on a part until its file is stored, so a failure never loses anything. Outside mirror
 * mode a tick reads the mode and nothing else.
 */
export class MirrorWorker {
  private stopped = true
  private loops: Promise<void>[] = []
  private wakers = new Set<() => void>()
  /** The last tick ran in mirror mode. False at start: the first mirror tick restarts the walk. */
  private mirroring = false

  constructor(private deps: MirrorWorkerDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.mirroring = false
    const concurrency = Math.max(1, Number(process.env.BRIDGE_MIRROR_CONCURRENCY) || 1)
    const pollMs = Math.max(1, Number(process.env.BRIDGE_MIRROR_POLL_MS) || 15000)
    void sweepMirrorTemp(
      process.env.BRIDGE_MIRROR_TMPDIR || tmpdir(),
      LEASE_SECONDS * 1000,
      this.deps.now(),
      this.deps.log,
    ).catch(() => {})
    for (let i = 0; i < concurrency; i++) this.loops.push(this.loop(pollMs))
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const wake of this.wakers) wake()
    const loops = this.loops
    this.loops = []
    await Promise.all(loops)
  }

  private async loop(pollMs: number): Promise<void> {
    while (!this.stopped) {
      let result: 'idle' | 'worked' = 'idle'
      try {
        result = await this.tick()
      } catch (error: any) {
        this.deps.log.error('Mirror tick failed:', error?.message || error)
      }
      if (result === 'idle' && !this.stopped) await this.sleep(pollMs)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.wakers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wakers.add(done)
    })
  }

  /** `done` removes the queue row; every other state is stored on it. */
  private async finish(
    messageId: string,
    state: 'queued' | 'done' | 'too_large' | 'failed' | 'over_quota',
    attempts: number,
    extra: { retry?: number; largest?: number; error?: string } = {},
  ): Promise<void> {
    await this.deps.rpc('bridge_mirror_finish', {
      p_message_id: messageId,
      p_state: state,
      p_attempts: attempts,
      p_retry_seconds: extra.retry ?? null,
      p_largest_bytes: extra.largest ?? null,
      p_error: extra.error ?? null,
    })
  }

  async tick(): Promise<'idle' | 'worked'> {
    const { deps } = this
    const mode = await deps.mode()
    if (mode !== 'mirror') {
      this.mirroring = false
      return 'idle'
    }
    if (!this.mirroring) {
      // Entering mirror mode, gateway start included, restarts the backfill walk.
      this.mirroring = true
      try {
        await deps.rpc('bridge_mirror_restart_walk', {})
      } catch (error) {
        this.mirroring = false
        throw error
      }
    }
    const ceiling = await deps.ceiling()
    const observed = await deps.rpc('bridge_mirror_observe', { p_mode: mode, p_ceiling: ceiling })
    // While the walk runs, never wait the idle poll between batches, even when nothing was claimed.
    let walked = false
    if (!observed?.walk_done) {
      await deps.rpc('bridge_mirror_backfill', { p_limit: BACKFILL_BATCH })
      walked = true
    }

    const claimed = await deps.rpc('bridge_mirror_claim', { p_lease_seconds: LEASE_SECONDS })
    const row = Array.isArray(claimed) ? claimed[0] : claimed
    if (!row) return walked ? 'worked' : 'idle'

    const messageId: string = row.message_id
    const attempts: number = row.attempts ?? 0
    try {
      await this.process(messageId, attempts, ceiling)
    } catch (error: any) {
      deps.log.error(`Mirror of ${messageId} failed:`, error?.message || error)
      await this.finishWithError(messageId, attempts, error)
    }
    return 'worked'
  }

  private async finishWithError(messageId: string, attempts: number, error: any): Promise<void> {
    const next = attempts + 1
    const text = String(error?.message || error).slice(0, 500)
    if (next >= MAX_ATTEMPTS) {
      await this.finish(messageId, 'failed', next, { error: text })
    } else {
      await this.finish(messageId, 'queued', next, { retry: BACKOFF_SECONDS[next - 1], error: text })
    }
  }

  private async process(messageId: string, attempts: number, ceiling: number): Promise<void> {
    const { deps } = this
    const message = await deps.readMessage(messageId)
    if (!message || message.is_deleted === true || !Array.isArray(message.content)) {
      await this.finish(messageId, 'done', attempts)
      return
    }
    const content = message.content
    const botId = message.bot_id
    const channelId = message.channel_id

    // Expired or unsigned links first: nothing is downloaded until the bridge has re-signed them.
    if (content.some((part) => isCandidate(part) && needsDiscordResign(part.url, deps.now()))) {
      if (!deps.gateway.isBotConnected(botId)) {
        await this.finish(messageId, 'queued', attempts, { retry: OFFLINE_RETRY_SECONDS })
        return
      }
      deps.gateway.sendToBot(botId, {
        op: 0,
        t: 'REFRESH_ATTACHMENTS',
        d: { messageId, channelId, content },
      })
      const next = attempts + 1
      if (next >= MAX_ATTEMPTS) {
        await this.finish(messageId, 'failed', next, { error: 'Discord would not refresh the link' })
      } else {
        await this.finish(messageId, 'queued', next, { retry: REFRESH_RETRY_SECONDS })
      }
      return
    }

    const uploaded: Uploaded[] = []
    let largest = 0
    let gone = false
    let overQuota = false
    let failure: any = null
    for (let index = 0; index < content.length; index++) {
      const part = content[index]
      if (!isCandidate(part)) continue
      try {
        const mirrored = await deps.mirror(part.url, {
          botId,
          channelId,
          fileName: typeof part.fileName === 'string' ? part.fileName : undefined,
          contentType: typeof part.contentType === 'string' ? part.contentType : undefined,
          knownSize: typeof part.fileSize === 'number' ? part.fileSize : undefined,
          ceiling,
        })
        uploaded.push({ index, baseUrl: baseUrl(part.url), mirrored })
      } catch (error: any) {
        if (error instanceof TooLargeError) largest = Math.max(largest, error.bytes)
        else if (error instanceof OverQuotaError) overQuota = true
        else if (error instanceof GoneError) gone = true
        else failure = error
      }
    }

    if (uploaded.length > 0) {
      let kept: Uploaded[] | null
      try {
        kept = await this.write(messageId, content, uploaded)
      } catch (error) {
        // A refused write stored no path. Any other failure may precede its commit: the files
        // stay, and the message_media sweep takes them after a day if no message holds them.
        if (isDatabaseRefusal(error)) await this.discard(uploaded)
        throw error
      }
      await this.discard(uploaded.filter((u) => !kept?.includes(u)))
      if (kept === null) {
        // Lost the compare-and-swap twice: the message is being edited. The next try downloads
        // again, so this counts as an attempt and is bounded.
        const next = attempts + 1
        if (next >= MAX_ATTEMPTS) {
          await this.finish(messageId, 'failed', next, { error: 'message kept changing' })
        } else {
          await this.finish(messageId, 'queued', next, { retry: CONFLICT_RETRY_SECONDS })
        }
        return
      }
    }

    if (gone) await this.finish(messageId, 'failed', attempts, { error: 'gone from Discord' })
    else if (failure) await this.finishWithError(messageId, attempts, failure)
    else if (overQuota) await this.finish(messageId, 'over_quota', attempts, { error: 'over the server limit' })
    else if (largest > 0) await this.finish(messageId, 'too_large', attempts, { largest })
    else await this.finish(messageId, 'done', attempts)
  }

  /** Removes the stored files of `uploads` that no message references. Best effort. */
  private async discard(uploads: Uploaded[]): Promise<void> {
    if (uploads.length === 0) return
    try {
      await this.deps.discard(uploads.map((u) => u.mirrored.path))
    } catch (error: any) {
      this.deps.log.warn('Mirror cleanup failed:', error?.message || error)
    }
  }

  /**
   * One compare-and-swap write; on a lost swap, re-applies the stored paths to the fresh content
   * once. Returns the uploads a live message holds afterwards: none when the message is gone or
   * deleted, fewer when an edit dropped their parts. Null when both swaps lost.
   */
  private async write(messageId: string, read: any[], uploaded: Uploaded[]): Promise<Uploaded[] | null> {
    const { deps } = this
    const next = read.map((part, index) => {
      const hit = uploaded.find((u) => u.index === index)
      return hit ? toMirroredPart(part, hit.mirrored) : part
    })
    let kept = uploaded
    if (!(await deps.rpc('update_message_content_silent', { p_message_id: messageId, p_old_content: read, p_content: next }))) {
      const fresh = await deps.readMessage(messageId)
      if (!fresh || fresh.is_deleted === true || !Array.isArray(fresh.content)) return []
      const used = new Set<Uploaded>()
      const reapplied = fresh.content.map((part) => {
        if (!isCandidate(part)) return part
        const hit = uploaded.find((u) => !used.has(u) && u.baseUrl === baseUrl(part.url))
        if (!hit) return part
        used.add(hit)
        return toMirroredPart(part, hit.mirrored)
      })
      if (used.size === 0) return []
      const swapped = await deps.rpc('update_message_content_silent', {
        p_message_id: messageId,
        p_old_content: fresh.content,
        p_content: reapplied,
      })
      if (!swapped) return null
      kept = [...used]
    }
    // The swap compares content alone: a message deleted while its files downloaded takes the paths.
    const after = await deps.readMessage(messageId)
    return !after || after.is_deleted === true ? [] : kept
  }
}
