import { createHash } from 'node:crypto'
import type { Config, Pair } from './config.js'
import { botUserId, ghostOwner, ghostUserId } from './config.js'
import { Ghosts } from './Ghosts.js'
import { harmonyToMatrix, matrixToHarmony } from './Mentions.js'
import type { BridgeMember, MatrixMember, SenderMode } from './HarmonyClient.js'
import type { MatrixSendOptions, RoomMember } from './MatrixClient.js'
import { StorageError } from './Store.js'
import type { Store, Job } from './Store.js'
import { HttpError, isTransientError, type AvatarImage } from './http.js'

type RecordValue = Record<string, unknown>
export interface HarmonyTransport {
  sendMessage(channelId: string, content: string | RecordValue[], metadata: RecordValue): Promise<{ id: string }>
  channelIsPlaintext(channelId: string): Promise<boolean>
  requireMatrixBridge(channelId: string): Promise<void>
  relayAllowed(channelId: string, userId: string): Promise<boolean>
  uploadBridgeAvatar(channelId: string, image: AvatarImage): Promise<string>
  bridgeRoom(channelId: string): Promise<{ room_id: string; sender_mode: SenderMode }>
  bridgeMembers(channelId: string): Promise<BridgeMember[]>
  nativeAvatar(channelId: string, userId: string): Promise<AvatarImage>
  publishMatrixMembers(channelId: string, members: MatrixMember[]): void
}
export interface MatrixTransport {
  sendMessage(roomId: string, transactionId: string, body: string, options?: MatrixSendOptions): Promise<{ event_id: string }>
  roomIsPlaintext(roomId: string): Promise<boolean>
  roomMember(roomId: string, userId: string): Promise<{ display_name?: string; avatar_mxc?: string }>
  avatarThumbnail(mxc: string): Promise<AvatarImage>
  registerGhost(id: string, previouslyRegistered: boolean): Promise<void>
  joinGhost(roomId: string, id: string, profile: { displayname: string; avatar_url?: string }): Promise<void>
  leaveGhost(roomId: string, id: string): Promise<void>
  uploadAvatar(image: AvatarImage): Promise<string>
  roomMembers(roomId: string): Promise<RoomMember[]>
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
  private readonly ghosts: Ghosts
  private nextSync = Date.now() + 30_000
  private syncCursor = 0
  private refreshRemaining = 0
  get isHealthy(): boolean { return this.healthy }
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly harmony: HarmonyTransport,
    private readonly matrix: MatrixTransport,
    private readonly report: (message: string) => void = () => {},
  ) { this.ghosts = new Ghosts(config, store, harmony, matrix) }

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
        || !text(event.sender, 255) || !/^@[^\s:]+:[^\s/]+$/.test(event.sender!) || event.sender === botUserId(this.config) || ghostOwner(this.config, event.sender!)
        || !this.config.matrix.allowedUserIds.includes(event.sender!)
        || content['m.relates_to'] || content['m.new_content']) continue
      jobs.push({ direction: 'to_harmony', sourceId: event.event_id!, channelId: pair.harmonyChannelId,
        roomId: pair.matrixRoomId, payload: { sender: event.sender, body,
          ...(typeof content.formatted_body === 'string' && content.formatted_body.length <= 32_000 ? { formatted_body: content.formatted_body } : {}),
          mention_ids: Array.isArray(record(content['m.mentions']).user_ids) ? (record(content['m.mentions']).user_ids as unknown[]).filter(id => typeof id === 'string' && id.length <= 255).slice(0, 100) : [] } })
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
    if (Array.isArray(message.content_raw) && (message.content_raw.length > 1000
      || message.content_raw.some(part => { const value = record(part); return value.type === 'text' && (typeof value.text !== 'string' || value.text.length > 16_000) }))) return false
    const parts = Array.isArray(message.content_raw) ? message.content_raw.map(record).filter(part => part.type === 'text' || part.type === 'mention').map(part => part.type === 'text'
      ? { type: 'text', text: part.text as string }
      : { type: 'mention', userId: text(part.userId, 255), username: text(part.username, 100), bridgeSource: part.bridgeSource === 'matrix' ? 'matrix' : undefined, isBridged: part.isBridged === true }) : undefined
    const body = parts ? text(parts.map(part => part.type === 'text' ? part.text : `@${part.username || 'user'}`).join('')) : text(message.content)
    if (!body) return false
    const name = text(author.nickname, 100) || text(author.display_name, 100) || text(author.username, 100) || String(author.id)
    return this.store.enqueue({ direction: 'to_matrix', sourceId: String(message.id),
      channelId: pair.harmonyChannelId, roomId: pair.matrixRoomId,
      payload: { sender: author.id, name, body, ...(parts ? { parts } : {}) } })
  }

  async cleanupUnpairedGhosts(): Promise<void> {
    for (const roomId of this.store.ghostRooms()) {
      if (!this.config.pairs.some(pair => pair.matrixRoomId === roomId)) await this.ghosts.cleanup({ matrixRoomId: roomId }, new Set())
    }
  }

  requestMemberSync(): void {
    this.nextSync = 0
    this.syncCursor = 0
    this.refreshRemaining = this.config.pairs.length
  }

  private async refreshNextPair(): Promise<void> {
    if (Date.now() < this.nextSync) return
    const pair = this.config.pairs[this.syncCursor++ % this.config.pairs.length]
    this.refreshRemaining = Math.max(0, this.refreshRemaining - 1)
    this.nextSync = this.refreshRemaining ? 0 : Date.now() + Math.max(250, 30_000 / this.config.pairs.length)
    try {
      await this.ghosts.sync(pair)
      await this.ghosts.plaintext(pair)
      const members = (await this.matrix.roomMembers(pair.matrixRoomId)).filter(member => this.config.matrix.allowedUserIds.includes(member.id)
        && member.id !== botUserId(this.config) && !ghostOwner(this.config, member.id))
      const published: MatrixMember[] = []
      for (const member of members) {
        const avatarUrl = member.avatar_mxc ? await this.avatarForHarmony(pair, member.avatar_mxc) : undefined
        const username = member.id.slice(1, member.id.indexOf(':')).slice(0, 100)
        published.push({ id: member.id, username, displayName: member.display_name || username,
          avatarUrl: avatarUrl || null, source: 'matrix' })
      }
      await this.ghosts.plaintext(pair)
      this.harmony.publishMatrixMembers(pair.harmonyChannelId, published)
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      this.harmony.publishMatrixMembers(pair.harmonyChannelId, [])
      this.report('Member refresh refused; check binding, permissions, consent and plaintext policy')
    }
  }

  private async avatarForHarmony(pair: Pair, mxc: string): Promise<string | undefined> {
    let url = this.avatars.get(mxc)
    if (url) return url
    let image: AvatarImage | undefined
    try { image = await this.matrix.avatarThumbnail(mxc) } catch { /* Optional thumbnail. */ }
    if (this.store.isRoomBlocked(pair.matrixRoomId)) throw new HttpError('Matrix encryption fence blocks avatar upload', false)
    if (image) {
      try {
        url = await this.harmony.uploadBridgeAvatar(pair.harmonyChannelId, image)
        if (this.avatars.size >= 256) this.avatars.delete(this.avatars.keys().next().value!)
        this.avatars.set(mxc, url)
      } catch { /* Optional avatar upload. */ }
    }
    return url
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
    this.inFlight = (async () => { await this.refreshNextPair(); await this.deliverNext() })().catch(() => {
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
    let matrixSender = botUserId(this.config)
    let outbound: ReturnType<typeof harmonyToMatrix> | undefined
    let harmonyParts: RecordValue[] | undefined
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
        const mentionIds = job.payload.mention_ids
        if ((Array.isArray(mentionIds) && mentionIds.length) || body.startsWith('!mention ')) {
          const members = await this.ghosts.eligible(pair)
          const ownedIds = Array.isArray(mentionIds) ? mentionIds.filter(id => typeof id === 'string' && this.store.ownsGhost(id)) : []
          harmonyParts = matrixToHarmony(body, job.payload.formatted_body, ownedIds, members, this.config)
        }
        harmonyPlain = await this.harmony.channelIsPlaintext(job.channelId)
      } else {
        const mode = await this.ghosts.mode(pair)
        const proposed = mode === 'ghost' ? ghostUserId(this.config, sender) : botUserId(this.config)
        matrixSender = this.store.freezeSender(job, proposed)
        if (matrixSender !== proposed) throw new HttpError('Queued Matrix sender is frozen; administrator mode changed', false)
        if (!await this.harmony.relayAllowed(job.channelId, sender)) throw new HttpError('Member has not allowed relay', false)
        let members: BridgeMember[] = []
        if (mode === 'ghost') {
          members = await this.ghosts.eligible(pair)
          const member = members.find(member => member.id === sender)
          if (!member) throw new HttpError('Ghost sender is not an eligible allowlisted member', false)
          await this.ghosts.ensure(pair, member)
        }
        const parts = Array.isArray(job.payload.parts) ? job.payload.parts.map(record) : undefined
        const targets = new Map<string, string>()
        if (parts?.some(part => part.type === 'mention')) {
          const joined = await this.matrix.roomMembers(job.roomId)
          for (const member of joined) {
            if (this.config.matrix.allowedUserIds.includes(member.id) && member.id !== botUserId(this.config) && !ghostOwner(this.config, member.id)) targets.set(member.id, member.id)
            const owner = ghostOwner(this.config, member.id)
            if (mode === 'ghost' && owner && this.store.ownsGhost(member.id) && members.some(native => native.id === owner)) targets.set(owner, member.id)
          }
        }
        outbound = harmonyToMatrix(parts, body, targets, mode === 'relay' ? `[${job.payload.name} · Harmony] ` : '')
        allowed = await this.harmony.relayAllowed(job.channelId, sender)
        if (await this.ghosts.mode(pair) !== mode) throw new HttpError('Matrix sender mode changed during delivery', false)
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
        const result = await this.harmony.sendMessage(job.channelId, harmonyParts || body, {
          bridge_author: author,
          matrix_relay: { room_id: job.roomId, event_id: job.sourceId, sender },
        })
        destinationId = result.id
      } else {
        const transactionId = createHash('sha256').update(JSON.stringify([job.channelId, job.roomId, job.sourceId])).digest('hex')
        const result = await this.matrix.sendMessage(job.roomId, transactionId, outbound!.body, {
          sender: matrixSender, userIds: outbound!.userIds, formattedBody: outbound!.formattedBody,
        })
        destinationId = result.event_id
      }
    } catch (error) {
      this.deliveryFailure(job, error, harmonyWriteStarted)
      return
    }
    this.store.complete(job.id, destinationId)
  }
  private deliveryFailure(job: Job, error: unknown, harmonyWriteStarted: boolean): void {
    if (error instanceof StorageError) throw error
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
