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
import { MAX_MEDIA_BYTES, mediaName, type MediaFile, type MatrixFile } from './Media.js'

type RecordValue = Record<string, unknown>
export interface HarmonyTransport {
  sendMessage(channelId: string, content: string | RecordValue[], metadata: RecordValue, replyTo?: string): Promise<{ id: string }>
  canReplyTo(channelId: string, messageId: string): Promise<boolean>
  channelIsPlaintext(channelId: string): Promise<boolean>
  requireMatrixBridge(channelId: string): Promise<void>
  relayAllowed(channelId: string, userId: string): Promise<boolean>
  uploadBridgeAvatar(channelId: string, image: AvatarImage): Promise<string>
  bridgeRoom(channelId: string): Promise<{ room_id: string; sender_mode: SenderMode }>
  bridgeMembers(channelId: string): Promise<BridgeMember[]>
  nativeAvatar(channelId: string, userId: string): Promise<AvatarImage>
  publishMatrixMembers(channelId: string, members: MatrixMember[]): void
  downloadFile(channelId: string, messageId: string, index: number): Promise<MediaFile>
  uploadFile(channelId: string, file: MediaFile): Promise<RecordValue>
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
  downloadFile(mxc: string, name: string): Promise<MediaFile>
  uploadFile(file: MediaFile): Promise<string>
  sendFile(roomId: string, transactionId: string, file: MatrixFile, options?: MatrixSendOptions): Promise<{ event_id: string }>
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
const MAX_FILES = 20
type Attachment = { index: number; name: string; mxc?: string; unavailable?: boolean }
function mediaReference(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 2048
    && /^mxc:\/\/((?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?)\/[a-zA-Z0-9_-]+$/.test(value) ? value : undefined
}
function fileName(value: unknown): string {
  return mediaName(typeof value === 'string' ? (/(?:https?:|mxc:|data:)/i.test(value) ? undefined : value.split(/[?#]/, 1)[0]) : value)
}
function boundedFile(file: MediaFile): MediaFile {
  if (!file || !Buffer.isBuffer(file.bytes) || file.bytes.length > MAX_MEDIA_BYTES
    || typeof file.contentType !== 'string' || file.contentType.length > 127) throw new HttpError('Invalid or oversized media transfer', false)
  return { ...file, name: fileName(file.name) }
}
function oversized(value: unknown): boolean {
  return value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_MEDIA_BYTES)
}
function attachmentNotice(file: Attachment): string {
  return `[Attachment unavailable: ${fileName(file.name)}]`
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
      const relation = record(content['m.relates_to'])
      const replyEventId = text(record(relation['m.in_reply_to']).event_id, 255)
      if (content['m.relates_to'] !== undefined && (relation.rel_type !== undefined || !replyEventId || !/^\$\S+$/.test(replyEventId))) continue
      // Old reply fallbacks quote prior content; strip them before text limits or mention parsing.
      const cleanBody = typeof content.body === 'string' ? (replyEventId
        ? content.body.replace(/^(?:> [^\n]*(?:\n|$))+(?:\r?\n)?/, '') : content.body) : ''
      const media = ['m.image', 'm.file', 'm.audio', 'm.video'].includes(String(content.msgtype))
      const name = fileName(content.filename ?? cleanBody)
      const mxc = mediaReference(content.url)
      const files: Attachment[] = media ? [{ index: 0, name,
        ...(content.file === undefined && mxc && !oversized(record(content.info).size) && cleanBody.length <= 16_000
          ? { mxc } : { unavailable: true }) }] : []
      const body = media ? (typeof content.filename === 'string' && cleanBody !== content.filename ? text(cleanBody) || '' : '') : text(cleanBody)
      const formatted = typeof content.formatted_body === 'string' ? (replyEventId
        ? content.formatted_body.replace(/^<mx-reply>[\s\S]*?<\/mx-reply>/i, '') : content.formatted_body) : undefined
      if (!pair || !directionAllows(pair, 'to_harmony') || event.type !== 'm.room.message'
        || (!media && content.msgtype !== 'm.text') || !text(event.event_id, 255) || (!body && !files.length)
        || !text(event.sender, 255) || !/^@[^\s:]+:[^\s/]+$/.test(event.sender!) || event.sender === botUserId(this.config) || ghostOwner(this.config, event.sender!)
        || !this.config.matrix.allowedUserIds.includes(event.sender!)
        || content['m.new_content']) continue
      jobs.push({ direction: 'to_harmony', sourceId: event.event_id!, channelId: pair.harmonyChannelId,
        roomId: pair.matrixRoomId, payload: { sender: event.sender, body, ...(files.length ? { files } : {}),
          ...(formatted !== undefined && formatted.length <= 32_000 ? { formatted_body: formatted } : {}),
          ...(replyEventId ? { reply_to_event_id: replyEventId } : {}),
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
    const raw = Array.isArray(message.content_raw) ? message.content_raw.map(record) : undefined
    if (raw && raw.length > 1000) return false
    const allFiles: Attachment[] = raw?.flatMap((file, index) => file.type === 'file'
      ? [{ index, name: fileName(file.fileName), ...(oversized(file.fileSize) ? { unavailable: true } : {}) }] : []) || []
    const invalidText = raw?.some(part => part.type === 'text' && (typeof part.text !== 'string' || part.text.length > 16_000))
    if (invalidText && !allFiles.length) return false
    let parts: RecordValue[] | undefined = invalidText ? [{ type: 'text', text: '[Message text unavailable]' }]
      : raw?.filter(part => part.type === 'text' || part.type === 'mention').map(part => part.type === 'text'
        ? { type: 'text', text: part.text as string }
        : { type: 'mention', userId: text(part.userId, 255), username: text(part.username, 100), bridgeSource: part.bridgeSource === 'matrix' ? 'matrix' : undefined, isBridged: part.isBridged === true })
    let body = parts ? text(parts.map(part => part.type === 'text' ? part.text : `@${part.username || 'user'}`).join('')) : text(message.content)
    if (!body && allFiles.length && parts?.some(part => part.type === 'mention' || (typeof part.text === 'string' && part.text.length))) {
      body = '[Message text unavailable]'
      parts = [{ type: 'text', text: body }]
    }
    const files = allFiles.length > MAX_FILES ? [...allFiles.slice(0, MAX_FILES),
      { index: allFiles[MAX_FILES].index, name: `Additional attachments (limit ${MAX_FILES})`, unavailable: true }] : allFiles
    if (!body && !files.length) return false
    const name = text(author.nickname, 100) || text(author.display_name, 100) || text(author.username, 100) || String(author.id)
    return this.store.enqueue({ direction: 'to_matrix', sourceId: String(message.id),
      channelId: pair.harmonyChannelId, roomId: pair.matrixRoomId,
      payload: { sender: author.id, name, body: body || '', ...(parts ? { parts } : {}), ...(files.length ? { files } : {}) } })
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
    const files = Array.isArray(job.payload.files) && job.payload.files.length <= MAX_FILES + 1 ? job.payload.files.map(record) as Attachment[] : []
    const body = text(job.payload.body) || ''
    if ((job.payload.files !== undefined && (!Array.isArray(job.payload.files) || job.payload.files.length > MAX_FILES + 1))
      || (job.direction === 'to_harmony' && files.length > 1) || (!body && !files.length)
      || files.some(file => !Number.isSafeInteger(file.index) || file.index < 0 || file.index >= 1000
        || typeof file.name !== 'string' || file.name !== fileName(file.name)
        || (file.unavailable !== undefined && file.unavailable !== true)
        || ((job.direction === 'to_matrix' || file.unavailable) ? file.mxc !== undefined : !mediaReference(file.mxc)))) {
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
    const replyEventId = job.direction === 'to_harmony' ? text(job.payload.reply_to_event_id, 255) : null
    let replyTo = replyEventId ? this.store.findMapping('to_harmony', replyEventId, job.channelId, job.roomId)
      ?? this.store.findSource('to_matrix', replyEventId, job.channelId, job.roomId) ?? undefined : undefined
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
        if (replyTo && !await this.harmony.canReplyTo(job.channelId, replyTo)) replyTo = undefined
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
    let destinationId: string | undefined
    let harmonyWriteStarted = false
    try {
      if (job.direction === 'to_harmony') {
        if (files.length) {
          harmonyParts ||= body ? [{ type: 'text', text: body }] : []
          for (const descriptor of files) {
            let part: RecordValue | undefined
            if (!descriptor.unavailable && descriptor.mxc) {
              const file = await this.mediaStep(job, pair, matrixSender, async () => boundedFile(await this.matrix.downloadFile(descriptor.mxc!, descriptor.name)))
              if (file) part = await this.mediaStep(job, pair, matrixSender, () => this.harmony.uploadFile(job.channelId, file))
            }
            harmonyParts.push(part || { type: 'text', text: `${harmonyParts.length ? '\n' : ''}${attachmentNotice(descriptor)}` })
          }
          await this.mediaPolicy(job, pair, matrixSender)
          if (replyTo && !await this.harmony.canReplyTo(job.channelId, replyTo)) replyTo = undefined
          await this.mediaPolicy(job, pair, matrixSender)
        }
        harmonyWriteStarted = true
        const result = await this.harmony.sendMessage(job.channelId, harmonyParts || body, {
          bridge_author: author,
          matrix_relay: { room_id: job.roomId, event_id: job.sourceId, sender },
        }, replyTo)
        destinationId = result.id
      } else {
        const transactionId = createHash('sha256').update(JSON.stringify([job.channelId, job.roomId, job.sourceId])).digest('hex')
        if (body || outbound!.body.trim()) {
          if (files.length) await this.mediaPolicy(job, pair, matrixSender)
          const result = await this.matrix.sendMessage(job.roomId, transactionId, outbound!.body, {
            sender: matrixSender, userIds: outbound!.userIds, formattedBody: outbound!.formattedBody,
          })
          if (files.length) this.store.recordDestination(job, result.event_id)
          destinationId = result.event_id
        }
        for (const descriptor of files) {
          const fileTransaction = `${transactionId}.file-${descriptor.index}`
          let fileResult: { event_id: string } | undefined
          if (!descriptor.unavailable) {
            const file = await this.mediaStep(job, pair, matrixSender, async () => boundedFile(await this.harmony.downloadFile(job.channelId, job.sourceId, descriptor.index)))
            if (file) {
              const mxc = await this.mediaStep(job, pair, matrixSender, () => this.matrix.uploadFile(file))
              if (mxc) fileResult = await this.mediaStep(job, pair, matrixSender, () => this.matrix.sendFile(job.roomId, fileTransaction,
                { mxc, name: fileName(file.name), contentType: file.contentType, size: file.bytes.length }, { sender: matrixSender }))
            }
          }
          if (!fileResult) {
            await this.mediaPolicy(job, pair, matrixSender)
            fileResult = await this.matrix.sendMessage(job.roomId, fileTransaction, attachmentNotice(descriptor), { sender: matrixSender })
          }
          this.store.recordDestination(job, fileResult.event_id)
          destinationId ||= fileResult.event_id
        }
      }
    } catch (error) {
      this.deliveryFailure(job, error, harmonyWriteStarted)
      return
    }
    this.store.complete(job.id, destinationId!)
  }
  private mediaFence(roomId: string): void {
    let blocked: boolean
    try { blocked = this.store.isRoomBlocked(roomId) }
    catch { throw new StorageError('Media policy storage check failed') }
    if (blocked) throw new HttpError('Encryption fence blocks media relay', false)
  }

  private async mediaPolicy(job: Job, pair: Pair, matrixSender: string): Promise<void> {
    this.mediaFence(job.roomId)
    const sender = String(job.payload.sender)
    const allowed = job.direction === 'to_matrix' ? this.config.harmony.allowedUserIds : this.config.matrix.allowedUserIds
    if (!this.config.pairs.some(current => current.harmonyChannelId === job.channelId && current.matrixRoomId === job.roomId && directionAllows(current, job.direction))
      || !allowed.includes(sender)) throw new HttpError('Media source is no longer permitted', false)
    await this.harmony.requireMatrixBridge(job.channelId)
    const mode = await this.ghosts.mode(pair)
    if (job.direction === 'to_matrix' && matrixSender !== (mode === 'ghost' ? ghostUserId(this.config, sender) : botUserId(this.config))) {
      throw new HttpError('Frozen media sender mode changed', false)
    }
    if (!await this.harmony.channelIsPlaintext(job.channelId) || !await this.matrix.roomIsPlaintext(job.roomId)) {
      throw new HttpError('Media relay requires verified plaintext rooms', false)
    }
    if (job.direction === 'to_matrix') {
      if (!await this.harmony.relayAllowed(job.channelId, sender)) throw new HttpError('Media relay consent withdrawn', false)
      if (!await this.matrix.roomIsPlaintext(job.roomId)) throw new HttpError('Matrix destination became encrypted', false)
    } else {
      await this.matrix.roomMember(job.roomId, sender)
      if (!await this.harmony.channelIsPlaintext(job.channelId)) throw new HttpError('Harmony destination became encrypted', false)
    }
    this.mediaFence(job.roomId)
  }

  private async mediaStep<T>(job: Job, pair: Pair, matrixSender: string, transfer: () => Promise<T>): Promise<T | undefined> {
    await this.mediaPolicy(job, pair, matrixSender)
    let failure: unknown
    // Only the transport is caught; policy/storage failures must never become attachment notices.
    try { return await transfer() }
    catch (error) { if (error instanceof StorageError) throw error; failure = error }
    await this.mediaPolicy(job, pair, matrixSender)
    if (isTransientError(failure) && job.attempts < 7) throw failure
    return undefined
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
