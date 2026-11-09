import { endpoint, HttpError, requestJson, type FetchImpl } from './http.js';

export interface MatrixClientOptions {
  homeserverUrl: string;
  asToken: string;
  botUserId: string;
  fetchImpl?: FetchImpl;
}

export class MatrixClient {
  constructor(private readonly options: MatrixClientOptions) {}

  private request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const url = endpoint(this.options.homeserverUrl, `_matrix/client/v3/${path}`);
    url.searchParams.set('user_id', this.options.botUserId);
    return requestJson<T>(url, {
      method,
      headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, this.options.fetchImpl);
  }

  async sendMessage(roomId: string, transactionId: string, body: string): Promise<{ event_id: string }> {
    const result = await this.request<{ event_id?: unknown }>(
      `rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      'PUT', { msgtype: 'm.text', body, 'm.mentions': {} },
    );
    if (typeof result?.event_id !== 'string' || !result.event_id) throw new HttpError('Invalid Matrix message response', false);
    return { event_id: result.event_id };
  }

  async roomIsPlaintext(roomId: string): Promise<boolean> {
    try {
      await this.request(`rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`, 'GET');
      return false;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404 && error.errcode === 'M_NOT_FOUND') return true;
      throw error;
    }
  }

  async ensureRegistered(): Promise<void> {
    const match = /^@([^:]+):.+$/.exec(this.options.botUserId);
    if (!match) throw new HttpError('Invalid Matrix bot user ID', false);
    try {
      await requestJson(endpoint(this.options.homeserverUrl, '_matrix/client/v3/register'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'm.login.application_service', username: match[1] }),
      }, this.options.fetchImpl);
    } catch (error) {
      if (error instanceof HttpError && error.errcode === 'M_USER_IN_USE') return;
      throw error;
    }
  }

  async joinRoom(roomId: string): Promise<void> {
    await this.request(`join/${encodeURIComponent(roomId)}`, 'POST', {});
  }
}
