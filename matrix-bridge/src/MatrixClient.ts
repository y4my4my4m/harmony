import { endpoint, HttpError, requestJson, requestImage, type AvatarImage, type FetchImpl } from './http.js';

const mxcPattern = /^mxc:\/\/((?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?)\/([a-zA-Z0-9_-]+)$/;

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

  async roomMember(roomId: string, userId: string): Promise<{ display_name?: string; avatar_mxc?: string }> {
    const member = await this.request<{ membership?: unknown; displayname?: unknown; avatar_url?: unknown }>(
      `rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`, 'GET',
    );
    if (member?.membership !== 'join') throw new HttpError('Matrix sender is not a joined room member', false);
    const name = member.displayname;
    const result: { display_name?: string; avatar_mxc?: string } = {};
    if (typeof name === 'string' && name.trim() && name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(name)) result.display_name = name;
    if (typeof member.avatar_url === 'string' && member.avatar_url.length <= 2048
      && mxcPattern.test(member.avatar_url)) result.avatar_mxc = member.avatar_url;
    return result;
  }

  async avatarThumbnail(mxc: string): Promise<AvatarImage> {
    const match = mxcPattern.exec(mxc);
    if (!match || mxc.length > 2048) throw new HttpError('Invalid Matrix avatar URI', false);
    // Always ask the configured HS; the MXC server is only an encoded path component.
    const url = endpoint(this.options.homeserverUrl,
      `_matrix/client/v1/media/thumbnail/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`);
    url.search = new URLSearchParams({ width: '128', height: '128', method: 'scale' }).toString();
    return requestImage(url, { method: 'GET', headers: { Authorization: `Bearer ${this.options.asToken}` } }, this.options.fetchImpl);
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
