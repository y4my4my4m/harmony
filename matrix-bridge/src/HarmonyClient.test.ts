import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarmonyClient } from './HarmonyClient.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function client(fetchImpl = vi.fn<typeof fetch>(), gatewayUrl = 'ws://localhost:1') {
  const result = new HarmonyClient({ apiUrl: 'https://harmony.example/bot-gateway', gatewayUrl, token: 'SECRET', fetchImpl, reconnectMs: 15 });
  cleanups.push(() => result.stop());
  return result;
}
async function gateway() {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  cleanups.push(() => { for (const socket of server.clients) socket.terminate(); server.close(); });
  const address = server.address() as { port: number };
  return { server, url: `ws://127.0.0.1:${address.port}` };
}
const message = { id: 'message', channel_id: 'channel', author: { id: 'user' }, content: 'hello', content_raw: [{ type: 'text', text: 'hello' }], metadata: {}, is_system: false };

describe('HarmonyClient', () => {
  it('sends structured text, metadata and Bot auth without retries', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'sent' }));
    await expect(client(fetchImpl).sendMessage('channel/a', '@everyone hi', { matrix: 'event' })).resolves.toEqual({ id: 'sent' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://harmony.example/bot-gateway/api/v1/channels/channel%2Fa/messages');
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bot SECRET' } });
    expect(JSON.parse(init!.body as string)).toEqual({ content: [{ type: 'text', text: '@everyone hi' }], metadata: { matrix: 'event' } });
    fetchImpl.mockRejectedValue(new Error('SECRET'));
    await expect(client(fetchImpl).sendMessage('channel', 'hello', {})).rejects.toThrow('HTTP transport failed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('checks reply targets through permission/consent-filtered history in the exact channel', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harmony = client(fetchImpl);
    fetchImpl.mockResolvedValueOnce(Response.json({ id: 'parent/a', channel_id: 'channel' }));
    await expect(harmony.canReplyTo('channel', 'parent/a')).resolves.toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/messages/parent%2Fa');
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    for (const body of [{ id: 'parent/a', channel_id: 'other' }, { id: 'other', channel_id: 'channel' }, {}]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      await expect(harmony.canReplyTo('channel', 'parent/a')).resolves.toBe(false);
    }
    for (const status of [403, 404]) {
      fetchImpl.mockResolvedValueOnce(Response.json({}, { status }));
      await expect(harmony.canReplyTo('channel', 'parent/a')).resolves.toBe(false);
    }
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(harmony.canReplyTo('channel', 'parent/a')).rejects.toThrow();
  });

  it('posts the optional native reply pointer without changing the content or author metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'reply' }));
    await client(fetchImpl).sendMessage('channel', 'New text', { bridge_author: { platform: 'matrix' } }, 'parent');
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ content: [{ type: 'text', text: 'New text' }],
      metadata: { bridge_author: { platform: 'matrix' } }, reply_to: 'parent' });
  });

  it('downloads by stored raw attachment index with Bot auth, not supplied storage URLs', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('private bytes', { headers: {
      'Content-Type': 'application/octet-stream', 'X-File-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('写真.pdf') } }));
    await expect(client(fetchImpl).downloadFile('channel/a', 'message/b', 2)).resolves.toEqual({ bytes: Buffer.from('private bytes'), contentType: 'application/pdf', name: '写真.pdf' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://harmony.example/bot-gateway/api/v1/channels/channel%2Fa/messages/message%2Fb/bridge-files/2');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bot SECRET' }, redirect: 'error' });
    await expect(client(fetchImpl).downloadFile('channel', 'message', -1)).rejects.toThrow('Invalid attachment index');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('uploads raw media with encoded metadata and preserves the canonical server file part', async () => {
    const part = { type: 'file', path: 'c/channel/bridge/bot/hash.pdf', url: 'https://storage.test/private/file?token=signed',
      fileType: 'file', fileName: '写真.pdf', fileSize: 7, mimeType: 'application/pdf' };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...part, untrusted: 'dropped' }));
    await expect(client(fetchImpl).uploadFile('channel', { bytes: Buffer.from('content'), name: '写真.pdf', contentType: 'application/pdf' })).resolves.toEqual(part);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://harmony.example/bot-gateway/api/v1/channels/channel/bridge-files');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bot SECRET', 'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent('写真.pdf'), 'X-File-Type': 'application/pdf' }, body: Buffer.from('content'), redirect: 'error' });
  });

  it.each([{ path: 'c/other/bridge/bot/hash.pdf' }, { path: 'c/channel/bridge/bot/../hash.pdf' }, { url: 'javascript:SECRET' }, { fileSize: 52428801 },
    { fileName: '../secret.pdf' }, { mimeType: 'image/png\r\nSECRET' }, { type: 'url' }, { fileType: 'video' }])('rejects malformed uploaded attachment responses %j', async invalid => {
    const part = { type: 'file', path: 'c/channel/bridge/bot/hash.pdf', url: 'https://storage.test/file', fileType: 'file', fileName: 'file.pdf', fileSize: 1, mimeType: 'application/pdf', ...invalid };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(part));
    await expect(client(fetchImpl).uploadFile('channel', { bytes: Buffer.from('x'), name: 'file.pdf', contentType: 'application/pdf' })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('requires authoritative boolean encryption state', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harmony = client(fetchImpl);
    for (const encrypted of [true, false]) {
      fetchImpl.mockResolvedValueOnce(Response.json({ messages_encrypted: encrypted }));
      await expect(harmony.channelIsPlaintext('channel')).resolves.toBe(!encrypted);
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/api/v1/channels/channel/encryption');
    for (const body of [{}, { messages_encrypted: null }, { messages_encrypted: 'false' }]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      await expect(harmony.channelIsPlaintext('channel')).rejects.toThrow('Unknown Harmony channel encryption state');
    }
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(harmony.channelIsPlaintext('channel')).rejects.toThrow();
  });

  it('requires Matrix registration, rejecting ordinary/unregistered bots and unknown platforms', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harmony = client(fetchImpl);
    fetchImpl.mockResolvedValueOnce(Response.json({ platform: 'matrix' }));
    await expect(harmony.requireMatrixBridge('channel/a')).resolves.toBeUndefined();
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/channels/channel%2Fa/bridge-platform');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bot SECRET' } });
    for (const body of [{ platform: null }, { platform: 'discord' }, {}, { platform: true }]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      await expect(harmony.requireMatrixBridge('channel')).rejects.toThrow();
    }
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(harmony.requireMatrixBridge('channel')).rejects.toThrow();
  });

  it('only accepts explicit per-member relay consent and fails closed on unavailable policy', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const harmony = client(fetchImpl);
    for (const value of [true, false, null, undefined, 'true', 1]) {
      fetchImpl.mockResolvedValueOnce(Response.json({ relay_allowed: value }));
      await expect(harmony.relayAllowed('channel/a', 'user/b')).resolves.toBe(value === true);
    }
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/channels/channel%2Fa/bridge-consent/user%2Fb');
    for (const status of [403, 404, 503]) {
      fetchImpl.mockResolvedValueOnce(Response.json({}, { status }));
      await expect(harmony.relayAllowed('channel', 'user')).rejects.toThrow();
    }
  });

  it('uploads bounded Matrix images through the registered Gateway endpoint with Bot auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ avatar_url: 'https://storage.test/storage/v1/object/public/avatars/bridges/bot/hash.png' }));
    const image = { data: 'aW1hZ2U=', content_type: 'image/png' };
    await expect(client(fetchImpl).uploadBridgeAvatar('channel/a', image)).resolves.toContain('/avatars/bridges/');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/channels/channel%2Fa/bridge-avatar');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bot SECRET' }, body: JSON.stringify(image) });
    for (const avatar_url of ['mxc://test/a', 'javascript:alert(1)', 'https://user:secret@host/a', 'https://host/a?token=secret', 'http://host/a', null]) {
      fetchImpl.mockResolvedValueOnce(Response.json({ avatar_url }));
      await expect(client(fetchImpl).uploadBridgeAvatar('channel', image)).rejects.toThrow();
    }
  });

  it('binds an initial sender mode but accepts the authoritative DB mode afterward', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ room_id: '!room:test', sender_mode: 'relay' }));
    const harmony = client(fetchImpl);
    await expect(harmony.bridgeRoom('channel', { room_id: '!room:test', initial_sender_mode: 'ghost' })).resolves.toEqual({ room_id: '!room:test', sender_mode: 'relay' });
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('PUT');
    await harmony.bridgeRoom('channel');
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('GET');
    fetchImpl.mockResolvedValueOnce(Response.json({ room_id: '!room:test', sender_mode: 'anything' }));
    await expect(harmony.bridgeRoom('channel')).rejects.toThrow();
  });

  it('reads trusted native avatar bytes with bounded JSON and never follows member URLs', async () => {
    const data = Buffer.alloc(1024 * 1024).toString('base64');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data, content_type: 'image/png' }));
    const harmony = client(fetchImpl);
    await expect(harmony.nativeAvatar('channel', 'user')).resolves.toEqual({ data, content_type: 'image/png' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/channels/channel/bridge-members/user/avatar');
    for (const body of [{ data: '!!!!', content_type: 'image/png' }, { data: 'aW1hZ2U=', content_type: 'image/svg+xml' }, { data: '', content_type: 'image/png' }]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      await expect(harmony.nativeAvatar('channel', 'user')).rejects.toThrow();
    }
  });

  it('identifies with op 2, accepts messages before READY and heartbeats with op 1', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    const received = vi.fn();
    harmony.on('message', received);
    const ready = once(harmony, 'ready');
    const connection = once(server, 'connection');
    harmony.start(); harmony.start();
    const [socket] = await connection;
    const [identify] = await once(socket, 'message');
    expect(JSON.parse(identify.toString())).toEqual({ op: 2, d: { token: 'SECRET' } });
    socket.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: message }));
    socket.send(JSON.stringify({ op: 0, t: 'MESSAGE_UPDATE', d: message }));
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 20 } }));
    await ready;
    expect(received).toHaveBeenCalledExactlyOnceWith({ ...message, encrypted: false });
    const [heartbeat] = await once(socket, 'message');
    expect(JSON.parse(heartbeat.toString())).toEqual({ op: 1 });
    socket.send(JSON.stringify({ op: 11 }));
    harmony.stop();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.clients.size).toBe(0);
  });

  it('publishes full Matrix member snapshots across channels, empty updates and READY refreshes', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    const frames: any[] = [];
    const connected = once(server, 'connection');
    const member = { id: '@sam:test', username: 'sam', displayName: 'Sam', avatarUrl: null, source: 'matrix' as const };
    let refreshes = 0;
    harmony.on('ready', () => { refreshes++; harmony.publishMatrixMembers('channel-a', [member]); });
    harmony.start();
    const [socket] = await connected;
    await once(socket, 'message'); // Identify precedes snapshots.
    socket.on('message', (raw: Buffer) => { const frame = JSON.parse(raw.toString()); if (frame.op === 6) frames.push(frame.d); });
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10_000 } }));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    harmony.publishMatrixMembers('channel-b', [member]);
    harmony.publishMatrixMembers('channel-a', []);
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames[2]).toEqual({ platform: 'matrix', channels: [{ harmonyChannelId: 'channel-a', members: [] }, { harmonyChannelId: 'channel-b', members: [member] }] });
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10_000 } }));
    await vi.waitFor(() => expect(frames).toHaveLength(4));
    expect(refreshes).toBe(2);
    expect(frames[3].channels).toEqual([{ harmonyChannelId: 'channel-a', members: [member] }, { harmonyChannelId: 'channel-b', members: [member] }]);
  });

  it('reconnects after disconnect but never loops on revoked tokens', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    const errors = vi.fn();
    harmony.on('error', errors);
    const connections = vi.fn();
    server.on('connection', connections);
    let connected = once(server, 'connection');
    harmony.start();
    let [socket] = await connected;
    await once(socket, 'message');
    connected = once(server, 'connection');
    socket.close(1000);
    [socket] = await connected;
    await once(socket, 'message');
    socket.close(4004, 'Token revoked SECRET');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(connections).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls.map(([e]) => e.message).join()).not.toContain('SECRET');
    expect(errors).toHaveBeenCalled();
  });

  it('reconnects when heartbeats are not acknowledged', async () => {
    const { server, url } = await gateway();
    const harmony = client(undefined, url);
    let connected = once(server, 'connection');
    harmony.start();
    const [socket] = await connected;
    await once(socket, 'message');
    connected = once(server, 'connection');
    socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 10 } }));
    await connected;
    harmony.stop();
  });
});
