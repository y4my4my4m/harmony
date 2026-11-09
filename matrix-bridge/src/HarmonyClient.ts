import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { endpoint, HttpError, requestJson, type FetchImpl } from './http.js';

export interface HarmonyClientOptions {
  apiUrl: string;
  gatewayUrl: string;
  token: string;
  fetchImpl?: FetchImpl;
  reconnectMs?: number;
  heartbeatMs?: number;
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

  private request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const base = this.options.apiUrl.replace(/\/$/, '');
    const url = endpoint(base, /\/api\/v1$/.test(base) ? path : `api/v1/${path}`);
    return requestJson<T>(url, {
      method,
      headers: { Authorization: `Bot ${this.options.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, this.options.fetchImpl);
  }

  async sendMessage(channelId: string, content: string, metadata: Record<string, unknown>): Promise<{ id: string }> {
    const result = await this.request<{ id?: unknown }>(`channels/${encodeURIComponent(channelId)}/messages`, 'POST', {
      content: [{ type: 'text', text: content }], metadata,
    });
    if (typeof result?.id !== 'string' || !result.id) throw new HttpError('Invalid Harmony message response', false);
    return { id: result.id };
  }

  async channelIsPlaintext(channelId: string): Promise<boolean> {
    const result = await this.request<{ messages_encrypted?: unknown }>(
      `channels/${encodeURIComponent(channelId)}/encryption`, 'GET',
    );
    if (typeof result?.messages_encrypted !== 'boolean') throw new HttpError('Unknown Harmony channel encryption state', false);
    return !result.messages_encrypted;
  }
}
