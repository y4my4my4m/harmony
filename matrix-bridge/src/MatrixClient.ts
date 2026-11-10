import { endpoint, HttpError, requestJson, requestImage, requestFile, type AvatarImage, type FetchImpl } from './http.js';
import { MAX_MEDIA_BYTES, isInlineImage, mediaContentType, mediaName, type MediaFile, type MatrixFile } from './Media.js';

const mxcPattern = /^mxc:\/\/((?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?)\/([a-zA-Z0-9_-]+)$/;

export interface MatrixSendOptions { sender?: string; userIds?: string[]; formattedBody?: string }
export interface RoomMember { id: string; display_name?: string; avatar_mxc?: string }

export interface MatrixClientOptions {
  homeserverUrl: string;
  asToken: string;
  botUserId: string;
  fetchImpl?: FetchImpl;
}

export class MatrixClient {
  constructor(private readonly options: MatrixClientOptions) {}

  private request<T>(path: string, method: string, body?: unknown, sender = this.options.botUserId): Promise<T> {
    const url = endpoint(this.options.homeserverUrl, `_matrix/client/v3/${path}`);
    url.searchParams.set('user_id', sender);
    return requestJson<T>(url, {
      method,
      headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, this.options.fetchImpl);
  }

  async sendMessage(roomId: string, transactionId: string, body: string, options: MatrixSendOptions = {}): Promise<{ event_id: string }> {
    if (options.sender && options.sender !== this.options.botUserId) this.assertGhost(options.sender);
    const result = await this.request<{ event_id?: unknown }>(
      `rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
      'PUT', { msgtype: 'm.text', body, 'm.mentions': options.userIds?.length ? { user_ids: options.userIds } : {},
        ...(options.formattedBody ? { format: 'org.matrix.custom.html', formatted_body: options.formattedBody } : {}) }, options.sender,
    );
    if (typeof result?.event_id !== 'string' || !result.event_id) throw new HttpError('Invalid Matrix message response', false);
    return { event_id: result.event_id };
  }

  async downloadFile(mxc: string, name: string): Promise<MediaFile> {
    const match = mxcPattern.exec(mxc);
    if (!match || mxc.length > 2048) throw new HttpError('Invalid Matrix media URI', false);
    // Even remote MXC media goes through the configured authenticated homeserver.
    const url = endpoint(this.options.homeserverUrl,
      `_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`);
    return requestFile(url, { method: 'GET', headers: { Authorization: `Bearer ${this.options.asToken}` } }, this.options.fetchImpl, name);
  }

  async uploadFile(file: MediaFile): Promise<string> {
    if (file.bytes.byteLength > MAX_MEDIA_BYTES) throw new HttpError('Attachment exceeds transfer limit', false);
    const url = endpoint(this.options.homeserverUrl, '_matrix/media/v3/upload');
    url.searchParams.set('filename', mediaName(file.name));
    const result = await requestJson<{ content_uri?: unknown }>(url, {
      method: 'POST', headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': mediaContentType(file.contentType) },
      body: file.bytes,
    }, this.options.fetchImpl, 60_000);
    if (typeof result?.content_uri !== 'string' || result.content_uri.length > 2048 || !mxcPattern.test(result.content_uri)) throw new HttpError('Invalid Matrix media upload response', false);
    return result.content_uri;
  }

  async sendFile(roomId: string, transactionId: string, file: MatrixFile, options: MatrixSendOptions = {}): Promise<{ event_id: string }> {
    if (options.sender && options.sender !== this.options.botUserId) this.assertGhost(options.sender);
    if (file.mxc.length > 2048 || !mxcPattern.test(file.mxc) || !Number.isInteger(file.size) || file.size < 0 || file.size > MAX_MEDIA_BYTES) throw new HttpError('Invalid Matrix file', false);
    const name = mediaName(file.name);
    const contentType = mediaContentType(file.contentType);
    const result = await this.request<{ event_id?: unknown }>(
      `rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`, 'PUT',
      { msgtype: isInlineImage(contentType) ? 'm.image' : 'm.file', body: name, filename: name,
        url: file.mxc, info: { mimetype: contentType, size: file.size }, 'm.mentions': {} }, options.sender,
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

  private assertGhost(id: string): void {
    const colon = this.options.botUserId.indexOf(':');
    const prefix = `${this.options.botUserId.slice(0, colon)}_h_`;
    const suffix = this.options.botUserId.slice(colon);
    if (!id.startsWith(prefix) || !id.endsWith(suffix) || !/^[0-9a-f]{32}$/.test(id.slice(prefix.length, -suffix.length))) {
      throw new HttpError('Sender outside dedicated ghost namespace', false);
    }
  }

  async registerGhost(id: string, previouslyRegistered: boolean): Promise<void> {
    this.assertGhost(id);
    try {
      await requestJson(endpoint(this.options.homeserverUrl, '_matrix/client/v3/register'), {
        method: 'POST', headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'm.login.application_service', username: id.slice(1, id.indexOf(':')) }),
      }, this.options.fetchImpl);
    } catch (error) {
      if (!(error instanceof HttpError && error.errcode === 'M_USER_IN_USE' && previouslyRegistered)) throw error;
    }
    const who = await this.request<{ user_id?: unknown }>('account/whoami', 'GET', undefined, id);
    if (who?.user_id !== id) throw new HttpError('Application service cannot own ghost sender', false);
  }

  async joinGhost(roomId: string, id: string, profile: { displayname: string; avatar_url?: string }): Promise<void> {
    this.assertGhost(id);
    let joined = false;
    let unchanged = false;
    let currentAvatar: string | undefined;
    try {
      const member = await this.request<{ membership?: unknown; displayname?: unknown; avatar_url?: unknown }>(`rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(id)}`, 'GET');
      joined = member?.membership === 'join';
      currentAvatar = typeof member?.avatar_url === 'string' ? member.avatar_url : undefined;
      unchanged = joined && member.displayname === profile.displayname && (profile.avatar_url === undefined || (currentAvatar || '') === profile.avatar_url);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404 && error.errcode === 'M_NOT_FOUND')) throw error;
    }
    if (!joined) {
      await this.request(`rooms/${encodeURIComponent(roomId)}/invite`, 'POST', { user_id: id });
      await this.request(`join/${encodeURIComponent(roomId)}`, 'POST', {}, id);
    }
    const avatar = profile.avatar_url === undefined ? currentAvatar : profile.avatar_url;
    if (!unchanged) await this.request(`rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(id)}`, 'PUT', {
      membership: 'join', displayname: profile.displayname, ...(avatar !== undefined ? { avatar_url: avatar } : {}),
    }, id);
  }

  async leaveGhost(roomId: string, id: string): Promise<void> {
    this.assertGhost(id);
    await this.request(`rooms/${encodeURIComponent(roomId)}/leave`, 'POST', {}, id);
  }

  async uploadAvatar(image: AvatarImage): Promise<string> {
    const result = await requestJson<{ content_uri?: unknown }>(endpoint(this.options.homeserverUrl, '_matrix/media/v3/upload'), {
      method: 'POST', headers: { Authorization: `Bearer ${this.options.asToken}`, 'Content-Type': image.content_type },
      body: Buffer.from(image.data, 'base64'),
    }, this.options.fetchImpl);
    if (typeof result?.content_uri !== 'string' || result.content_uri.length > 2048 || !mxcPattern.test(result.content_uri)) throw new HttpError('Invalid Matrix avatar upload response', false);
    return result.content_uri;
  }

  async roomMembers(roomId: string): Promise<RoomMember[]> {
    const result = await this.request<{ joined?: Record<string, { display_name?: unknown; avatar_url?: unknown }> }>(
      `rooms/${encodeURIComponent(roomId)}/joined_members`, 'GET');
    if (!result?.joined || typeof result.joined !== 'object' || Array.isArray(result.joined) || Object.keys(result.joined).length > 1000) throw new HttpError('Invalid or oversized Matrix membership', false);
    return Object.entries(result.joined).filter(([id]) => id.length <= 255 && /^@[^\s:]+:[^\s/]+$/.test(id)).map(([id, member]) => ({ id,
      ...(typeof member?.display_name === 'string' && member.display_name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(member.display_name) ? { display_name: member.display_name } : {}),
      ...(typeof member?.avatar_url === 'string' && member.avatar_url.length <= 2048 && mxcPattern.test(member.avatar_url) ? { avatar_mxc: member.avatar_url } : {}),
    }));
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
