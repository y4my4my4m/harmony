import { createHash } from 'node:crypto'
import type { Config, Pair } from './config.js'
import { botUserId } from './config.js'
import type { Store, Job } from './Store.js'
import { HttpError, isTransientError, type AvatarImage } from './http.js'

type RecordValue = Record<string, unknown>
export interface HarmonyTransport {
  sendMessage(channelId: string, content: string, metadata: RecordValue): Promise<{ id: string }>
  channelIsPlaintext(channelId: string): Promise<boolean>
  requireMatrixBridge(channelId: string): Promise<void>
  relayAllowed(channelId: string, userId: string): Promise<boolean>
  uploadBridgeAvatar(channelId: string, image: AvatarImage): Promise<string>
}
export interface MatrixTransport {
  sendMessage(roomId: string, transactionId: string, body: string): Promise<{ event_id: string }>
  roomIsPlaintext(roomId: string): Promise<boolean>
  roomMember(roomId: string, userId: string): Promise<{ display_name?: string; avatar_mxc?: string }>
  avatarThumbnail(mxc: string): Promise<AvatarImage>
}
export interface MatrixEvent extends RecordValue {
  type: string
  event_id?: string
  room_id?: string
  sender?: string
  content?: RecordValue
}

function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}
function text(value: unknown, max = 16_000): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : null
}
function directionAllows(pair: Pair, direction: Job['direction']): boolean {
  return pair.direction === 'both' || pair.direction === direction
}

/** One worker per database. The queue is durable, but Harmony POST has no idempotency key. */
export class Relay {
  private timer?: ReturnType<typeof setInterval>
  private inFlight?: Promise<void>
  private healthy = true
  private readonly avatars = new Map<string, string>()
  get isHealthy(): boolean { return this.healthy }
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly harmony: HarmonyTransport,
    private readonly matrix: MatrixTransport,
    private readonly report: (message: string) => void = () => {},
  ) {}

  acceptTransaction(transactionId: string, events: MatrixEvent[]): boolean {
    if (!this.healthy) throw new Error('Worker requires restart after storage failure')
    const jobs: Array<Omit<Job, 'id' | 'attempts'>> = []
    const encryptedRoomIds = events.filter(event => event.type === 'm.room.encryption'
      && this.config.pairs.some(pair => pair.matrixRoomId === event.room_id)).map(event => event.room_id!)
    for (const event of events) {
      const pair = this.config.pairs.find(pair => pair.matrixRoomId === event.room_id)
      const content = record(event.content)
      const body = text(content.body)
      if (!pair || !directionAllows(pair, 'to_harmony') || event.type !== 'm.room.message'
        || content.msgtype !== 'm.text' || !text(event.event_id, 255) || !body
        || !text(event.sender, 255) || !/^@[^\s:]+:[^\s/]+$/.test(event.sender!) || event.sender === botUserId(this.config)
        || !this.config.matrix.allowedUserIds.includes(event.sender!)
        || content['m.relates_to'] || content['m.new_content']) continue
      jobs.push({ direction: 'to_harmony', sourceId: event.event_id!, channelId: pair.harmonyChannelId,
        roomId: pair.matrixRoomId, payload: { sender: event.sender, body } })
    }
    return this.store.acceptTransaction(transactionId, jobs, encryptedRoomIds)
  }

  acceptHarmonyMessage(message: RecordValue): boolean {
    if (!this.healthy) throw new Error('Worker requires restart after storage failure')
    const pair = this.config.pairs.find(pair => pair.harmonyChannelId === message.channel_id)
    const author = record(message.author)
    const metadata = record(message.metadata)
    if (!pair || !directionAllows(pair, 'to_matrix') || !text(message.id, 255)
      || message.encrypted === true || message.is_system || message.thread_id
      || author.bot || author.discord_user || message.bot_id
      || metadata.discord_user || metadata.bridge_source || metadata.matrix_relay || metadata.bridge_author
      || !this.config.harmony.allowedUserIds.includes(String(author.id))) return false
    // Only text in this first slice; never flatten files, system parts or mentions into a new ping.
    const parts = message.content_raw
    const body = Array.isArray(parts)
      ? text(parts.filter(part => record(part).type === 'text').map(part => record(part).text).filter(value => typeof value === 'string').join('\n'))
      : text(message.content)
    if (!body) return false
    const name = text(author.nickname, 100) || text(author.display_name, 100) || text(author.username, 100) || String(author.id)
    return this.store.enqueue({ direction: 'to_matrix', sourceId: String(message.id),
      channelId: pair.harmonyChannelId, roomId: pair.matrixRoomId,
      payload: { sender: author.id, name, body } })
  }

  start(): void {
    if (this.timer || !this.healthy) return
    this.timer = setInterval(() => { void this.tick() }, 250)
    void this.tick()
  }
  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
    await this.inFlight
  }
  async tick(): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (!this.healthy) return
    this.inFlight = this.deliverNext().catch(() => {
      this.healthy = false
      clearInterval(this.timer)
      this.timer = undefined
      this.report('Storage failure; worker paused and requires restart')
    })
    try { await this.inFlight } finally { this.inFlight = undefined }
  }
  private async deliverNext(): Promise<void> {
    const job = this.store.nextJob()
    if (!job) return
    const pair = this.config.pairs.find(pair => pair.harmonyChannelId === job.channelId && pair.matrixRoomId === job.roomId)
    const sender = String(job.payload.sender)
    const permitted = job.direction === 'to_matrix'
      ? this.config.harmony.allowedUserIds.includes(sender)
      : this.config.matrix.allowedUserIds.includes(sender)
    if (!pair || !directionAllows(pair, job.direction) || !permitted) {
      this.store.fail(job.id, 'Pair or sender is no longer permitted')
      return
    }
    const body = text(job.payload.body)
    if (!body) {
      this.store.fail(job.id, 'Invalid queued payload')
      return
    }
    // Check the destination last, immediately before sending. Durable Matrix encryption
    // event fences also cancel queued/in-flight preflights. Neither API offers an atomic
    // check-and-send, so a residual server-side policy race remains (see README).
    let harmonyPlain: boolean
    let matrixPlain: boolean
    let allowed = false
    const author: RecordValue = { platform: 'matrix', id: sender, username: sender.slice(1, sender.indexOf(':')).slice(0, 100) }
    try {
      await this.harmony.requireMatrixBridge(job.channelId)
      if (job.direction === 'to_harmony') {
        if (!text(sender, 255) || !/^@[^\s:]+:[^\s/]+$/.test(sender)) throw new HttpError('Invalid Matrix sender', false)
        matrixPlain = await this.matrix.roomIsPlaintext(job.roomId)
        harmonyPlain = await this.harmony.channelIsPlaintext(job.channelId)
      } else {
        harmonyPlain = await this.harmony.channelIsPlaintext(job.channelId)
        matrixPlain = await this.matrix.roomIsPlaintext(job.roomId)
      }
    } catch (error) {
      this.deliveryFailure(job, error, false)
      return
    }
    // Storage operations deliberately live outside transport catches: disk failures must
    // pause the worker with the job intact, never masquerade as a refused remote delivery.
    if (!harmonyPlain || !matrixPlain || this.store.isRoomBlocked(job.roomId)) {
      this.store.fail(job.id, 'Encrypted channels and rooms are not supported')
      return
    }
    if (job.direction === 'to_harmony') {
      let member: { display_name?: string; avatar_mxc?: string }
      try { member = await this.matrix.roomMember(job.roomId, sender) }
      catch (error) { this.deliveryFailure(job, error, false); return }
      if (this.store.isRoomBlocked(job.roomId)) {
        this.store.fail(job.id, 'Matrix room encryption fence blocks profile relay')
        return
      }
      if (member.display_name) author.display_name = member.display_name
      if (member.avatar_mxc) {
        let url = this.avatars.get(member.avatar_mxc)
        if (!url) {
          let image: AvatarImage | undefined
          try { image = await this.matrix.avatarThumbnail(member.avatar_mxc) }
          catch { /* Avatars are optional; never drop text or expose remote errors. */ }
          if (this.store.isRoomBlocked(job.roomId)) {
            this.store.fail(job.id, 'Matrix room encryption fence blocks avatar upload')
            return
          }
          if (image) {
            try {
              url = await this.harmony.uploadBridgeAvatar(job.channelId, image)
              if (this.avatars.size >= 256) this.avatars.delete(this.avatars.keys().next().value!)
              this.avatars.set(member.avatar_mxc, url)
            } catch { /* Missing/failed avatar storage must not prevent text delivery. */ }
          }
        }
        if (url) author.avatar_url = url
      }
    }
    try {
      if (job.direction === 'to_harmony') {
        harmonyPlain = await this.harmony.channelIsPlaintext(job.channelId)
      } else {
        allowed = await this.harmony.relayAllowed(job.channelId, sender)
        matrixPlain = await this.matrix.roomIsPlaintext(job.roomId)
      }
    } catch (error) {
      this.deliveryFailure(job, error, false)
      return
    }
    if (!harmonyPlain || !matrixPlain || this.store.isRoomBlocked(job.roomId)) {
      this.store.fail(job.id, 'Encrypted channels and rooms are not supported')
      return
    }
    if (job.direction === 'to_matrix' && allowed !== true) {
      this.store.fail(job.id, 'Member has not allowed relay')
      return
    }
    let destinationId: string
    const harmonyWriteStarted = job.direction === 'to_harmony'
    try {
      if (harmonyWriteStarted) {
        const result = await this.harmony.sendMessage(job.channelId, body, {
          bridge_author: author,
          matrix_relay: { room_id: job.roomId, event_id: job.sourceId, sender },
        })
        destinationId = result.id
      } else {
        const transactionId = createHash('sha256').update(JSON.stringify([job.channelId, job.roomId, job.sourceId])).digest('hex')
        const result = await this.matrix.sendMessage(job.roomId, transactionId, `[${job.payload.name} · Harmony] ${body}`)
        destinationId = result.event_id
      }
    } catch (error) {
      this.deliveryFailure(job, error, harmonyWriteStarted)
      return
    }
    this.store.complete(job.id, destinationId)
  }
  private deliveryFailure(job: Job, error: unknown, harmonyWriteStarted: boolean): void {
    // Never persist arbitrary exception text: it may contain access tokens or message content.
    // Only a rate-limit rejection is known to occur before the Harmony handler runs.
    // Network errors/5xx after starting its non-idempotent POST are never blindly retried.
    const retrySafe = !harmonyWriteStarted || (error instanceof HttpError && error.status === 429)
    if (retrySafe && isTransientError(error) && job.attempts < 7) {
      const delay = Math.max(Math.min(60_000, 1000 * 2 ** job.attempts), error instanceof HttpError ? error.retryAfterMs ?? 0 : 0)
      this.store.retry(job.id, 'Transient delivery failure', delay)
      this.report('Delivery delayed; retry scheduled')
    } else {
      this.store.fail(job.id, harmonyWriteStarted ? 'Harmony send failed or outcome uncertain; not retried' : 'Delivery refused or retry limit reached')
      this.report('Delivery failed; inspect permissions, encryption and connectivity')
    }
  }
}
