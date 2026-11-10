import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { endpoint, HttpError, requestJson, requestFile, type AvatarImage, type FetchImpl } from './http.js';
import { MAX_MEDIA_BYTES, mediaContentType, mediaName, type MediaFile } from './Media.js';

export interface HarmonyClientOptions {
  apiUrl: string;
  gatewayUrl: string;
  token: string;
  fetchImpl?: FetchImpl;
  reconnectMs?: number;
  heartbeatMs?: number;
}

export type SenderMode = 'ghost' | 'relay';
export interface BridgeMember {
  id: string; username: string; display_name: string | null; avatar_url: string | null; domain: string | null;
}
export interface MatrixMember {
  id: string; username: string; displayName: string; avatarUrl: string | null; source: 'matrix';
}

export interface HarmonyMessage {
  id: string;
  channel_id: string;
  author: { id: string; [key: string]: unknown } | null;
  metadata: Record<string, unknown>;
  content: string;
  content_raw: unknown[];
  encrypted: boolean;
  is_system: boolean;
  [key: string]: unknown;
}

export class HarmonyClient extends EventEmitter {
  private socket?: WebSocket;
  private running = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private readonly matrixMembers = new Map<string, MatrixMember[]>();

  constructor(private readonly options: HarmonyClientOptions) {
    super();
  }

  private report(message: string): void {
    // EventEmitter throws for an unobserved 'error'; a socket error must not crash the service.
    if (this.listenerCount('error')) this.emit('error', new Error(message));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.clearConnectionTimers();
    const socket = this.socket;
    this.socket = undefined;
    socket?.terminate();
  }

  private clearConnectionTimers(): void {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.readyTimer);
  }

  private connect(): void {
    if (!this.running) return;
    let socket: WebSocket;
    try {
      const url = new URL(this.options.gatewayUrl);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      socket = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 1024 * 1024 });
    } catch {
      this.running = false;
      this.report('Invalid Harmony gateway URL');
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket || !this.running) return;
      socket.send(JSON.stringify({ op: 2, d: { token: this.options.token } }));
      this.readyTimer = setTimeout(() => {
        this.report('Harmony gateway ready timed out');
        socket.terminate();
      }, 30_000);
    });
    let awaitingAck = false;
    socket.on('message', (raw) => {
      if (this.socket !== socket || !this.running) return;
      let frame;
      try { frame = JSON.parse(raw.toString()); }
      catch { this.report('Invalid Harmony gateway frame'); return; }
      if (!frame || typeof frame !== 'object') return;
      if (frame.op === 11) { awaitingAck = false; return; }
      if (frame.op !== 0) return;
      if (frame.t === 'READY') {
        clearTimeout(this.readyTimer);
        clearInterval(this.heartbeatTimer);
        const interval = this.options.heartbeatMs ?? frame.d?.heartbeat_interval;
        if (!Number.isFinite(interval) || interval <= 0 || interval > 2_147_483_647) {
          this.report('Invalid Harmony heartbeat interval');
          socket.terminate();
          return;
        }
        this.heartbeatTimer = setInterval(() => {
          if (awaitingAck) { socket.terminate(); return; }
          if (socket.readyState === WebSocket.OPEN) {
            awaitingAck = true;
            socket.send(JSON.stringify({ op: 1 }));
          }
        }, interval);
        this.emit('ready', frame.d);
      } else if (frame.t === 'MESSAGE_CREATE') {
        const message = frame.d;
        if (!message || typeof message.id !== 'string' || typeof message.channel_id !== 'string'
          || typeof message.content !== 'string' || !Array.isArray(message.content_raw)
          || typeof message.is_system !== 'boolean' || !message.metadata || typeof message.metadata !== 'object'
          || Array.isArray(message.metadata)
          || !(message.author === null || (typeof message.author === 'object' && typeof message.author.id === 'string'))
          || (message.encrypted !== undefined && typeof message.encrypted !== 'boolean')) {
          this.report('Invalid Harmony message event');
          return;
        }
        // Gateway filters encrypted rows before dispatch; older versions omit this field.
        this.emit('message', { ...message, encrypted: message.encrypted ?? false } as HarmonyMessage);
      }
    });
    socket.on('error', () => {
      if (this.running && this.socket === socket) this.report('Harmony gateway connection failed');
    });
    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.clearConnectionTimers();
      this.emit('disconnected');
      const terminal = code === 4001 || (code === 4004 && reason.toString() !== 'Token verification unavailable');
      if (terminal) {
        this.running = false;
        this.report('Harmony gateway authentication refused');
      }
      if (this.running) {
        this.reconnectTimer = setTimeout(() => this.connect(), Math.max(10, this.options.reconnectMs ?? 5_000));
      }
    });
  }

  private apiEndpoint(path: string): URL {
    const base = this.options.apiUrl.replace(/\/$/, '');
    return endpoint(base, /\/api\/v1$/.test(base) ? path : `api/v1/${path}`);
  }

  private request<T>(path: string, method: string, body?: unknown, maxBytes?: number): Promise<T> {
    const url = this.apiEndpoint(path);
    return requestJson<T>(url, {
      method,
      headers: { Authorization: `Bot ${this.options.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, this.options.fetchImpl, 15_000, maxBytes);
  }

  async canReplyTo(channelId: string, messageId: string): Promise<boolean> {
    try {
      const result = await this.request<{ id?: unknown; channel_id?: unknown }>(`messages/${encodeURIComponent(messageId)}`, 'GET');
      return result?.id === messageId && result.channel_id === channelId;
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return false;
      throw error;
    }
  }

  async sendMessage(channelId: string, content: string | Record<string, unknown>[], metadata: Record<string, unknown>, replyTo?: string): Promise<{ id: string }> {
    const result = await this.request<{ id?: unknown }>(`channels/${encodeURIComponent(channelId)}/messages`, 'POST', {
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, metadata,
      ...(replyTo ? { reply_to: replyTo } : {}),
    });
    if (typeof result?.id !== 'string' || !result.id) throw new HttpError('Invalid Harmony message response', false);
    return { id: result.id };
  }

  async downloadFile(channelId: string, messageId: string, index: number): Promise<MediaFile> {
    if (!Number.isInteger(index) || index < 0 || index >= 1000) throw new HttpError('Invalid attachment index', false);
    return requestFile(this.apiEndpoint(`channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/bridge-files/${index}`),
      { method: 'GET', headers: { Authorization: `Bot ${this.options.token}` } }, this.options.fetchImpl);
  }

  async uploadFile(channelId: string, file: MediaFile): Promise<Record<string, unknown>> {
    if (file.bytes.byteLength > MAX_MEDIA_BYTES) throw new HttpError('Attachment exceeds transfer limit', false);
    const part = await requestJson<Record<string, unknown>>(this.apiEndpoint(`channels/${encodeURIComponent(channelId)}/bridge-files`), {
      method: 'POST', headers: { Authorization: `Bot ${this.options.token}`, 'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(mediaName(file.name)), 'X-File-Type': mediaContentType(file.contentType) },
      body: file.bytes,
    }, this.options.fetchImpl, 60_000);
    if (part?.type !== 'file' || typeof part.path !== 'string' || part.path.length > 2048
      || !part.path.startsWith(`c/${channelId.toLowerCase()}/bridge/`) || part.path.split('/').some(value => !value || value === '.' || value === '..')
      || typeof part.url !== 'string' || part.url.length > 4096 || typeof part.fileName !== 'string' || !part.fileName || part.fileName.length > 255
      || /[\\/\u0000-\u001f\u007f]/.test(part.fileName) || typeof part.mimeType !== 'string' || mediaContentType(part.mimeType) !== part.mimeType
      || !['image', 'file'].includes(String(part.fileType)) || !Number.isInteger(part.fileSize) || Number(part.fileSize) < 0 || Number(part.fileSize) > MAX_MEDIA_BYTES) throw new HttpError('Invalid bridge file response', false);
    try {
      const url = new URL(part.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { throw new HttpError('Invalid bridge file URL', false); }
    return { type: 'file', path: part.path, url: part.url, fileName: part.fileName,
      fileType: part.fileType, fileSize: part.fileSize, mimeType: part.mimeType };
  }

  async uploadBridgeAvatar(channelId: string, image: AvatarImage): Promise<string> {
    const result = await this.request<{ avatar_url?: unknown }>(
      `channels/${encodeURIComponent(channelId)}/bridge-avatar`, 'POST', image,
    );
    if (typeof result?.avatar_url !== 'string' || result.avatar_url.length > 2048) throw new HttpError('Invalid bridge avatar response', false);
    let url: URL;
    try { url = new URL(result.avatar_url); } catch { throw new HttpError('Invalid bridge avatar URL', false); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.protocol === 'http:' && new URL(this.options.apiUrl).protocol !== 'http:')) throw new HttpError('Invalid bridge avatar URL', false);
    return url.href;
  }

  publishMatrixMembers(channelId: string, members: MatrixMember[]): void {
    this.matrixMembers.set(channelId, members);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ op: 6, d: {
      platform: 'matrix', channels: [...this.matrixMembers].map(([harmonyChannelId, members]) => ({ harmonyChannelId, members })),
    } }));
  }

  async bridgeRoom(channelId: string, initial?: { room_id: string; initial_sender_mode: SenderMode }): Promise<{ room_id: string; sender_mode: SenderMode }> {
    const result = await this.request<{ room_id?: unknown; sender_mode?: unknown }>(
      `channels/${encodeURIComponent(channelId)}/bridge-room`, initial ? 'PUT' : 'GET', initial,
    );
    if (typeof result?.room_id !== 'string' || result.room_id.length > 255 || !/^![^\s/]+$/.test(result.room_id)
      || !['ghost', 'relay'].includes(String(result.sender_mode))) throw new HttpError('Invalid Matrix room binding', false);
    return result as { room_id: string; sender_mode: SenderMode };
  }

  async bridgeMembers(channelId: string): Promise<BridgeMember[]> {
    const result = await this.request<unknown>(`channels/${encodeURIComponent(channelId)}/bridge-members`, 'GET');
    if (!Array.isArray(result) || result.length > 1000) throw new HttpError('Invalid or oversized bridge member list', false);
    const seen = new Set<string>();
    return result.map(member => {
      if (!member || typeof member !== 'object' || typeof member.id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(member.id)
        || seen.has(member.id) || typeof member.username !== 'string' || !member.username.trim() || member.username.length > 100
        || /[\u0000-\u001f\u007f]/.test(member.username)) throw new HttpError('Invalid bridge member', false);
      seen.add(member.id);
      const bounded = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
      return { id: member.id, username: member.username, display_name: bounded(member.display_name, 100),
        avatar_url: bounded(member.avatar_url, 2048), domain: bounded(member.domain, 255) };
    });
  }

  async nativeAvatar(channelId: string, userId: string): Promise<AvatarImage> {
    const image = await this.request<AvatarImage>(`channels/${encodeURIComponent(channelId)}/bridge-members/${encodeURIComponent(userId)}/avatar`, 'GET', undefined, 1_400_000);
    if (!image || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.content_type)
      || typeof image.data !== 'string' || image.data.length > 1_398_104 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 !== 0
      || !image.data.length || Buffer.from(image.data, 'base64').length > 1_048_576
      || Buffer.from(image.data, 'base64').toString('base64') !== image.data) throw new HttpError('Invalid native avatar bytes', false);
    return image;
  }

  async requireMatrixBridge(channelId: string): Promise<void> {
    const result = await this.request<{ platform?: unknown }>(
      `channels/${encodeURIComponent(channelId)}/bridge-platform`, 'GET',
    );
    if (result?.platform !== 'matrix') throw new HttpError('Channel is not registered to this Matrix bridge', false);
  }

  async relayAllowed(channelId: string, userId: string): Promise<boolean> {
    const result = await this.request<{ relay_allowed?: unknown }>(
      `channels/${encodeURIComponent(channelId)}/bridge-consent/${encodeURIComponent(userId)}`, 'GET',
    );
    return result?.relay_allowed === true;
  }

  async channelIsPlaintext(channelId: string): Promise<boolean> {
    const result = await this.request<{ messages_encrypted?: unknown }>(
      `channels/${encodeURIComponent(channelId)}/encryption`, 'GET',
    );
    if (typeof result?.messages_encrypted !== 'boolean') throw new HttpError('Unknown Harmony channel encryption state', false);
    return !result.messages_encrypted;
  }
}
