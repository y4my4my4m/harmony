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
