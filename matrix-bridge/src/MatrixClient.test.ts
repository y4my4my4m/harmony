import { describe, expect, it, vi } from 'vitest';
import { MatrixClient } from './MatrixClient.js';

function setup() {
  const fetchImpl = vi.fn<typeof fetch>();
  const client = new MatrixClient({ homeserverUrl: 'https://matrix.example/proxy', asToken: 'SECRET', botUserId: '@relay:matrix.example', fetchImpl });
  return { fetchImpl, client };
}

describe('MatrixClient', () => {
  it('sends idempotent plaintext transactions as the AS bot', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ event_id: '$event' }));
    await expect(client.sendMessage('!room:example', 'txn/a', 'hello')).resolves.toEqual({ event_id: '$event' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://matrix.example/proxy/_matrix/client/v3/rooms/!room%3Aexample/send/m.room.message/txn%2Fa?user_id=%40relay%3Amatrix.example');
    expect(init).toMatchObject({ method: 'PUT', headers: { Authorization: 'Bearer SECRET' }, redirect: 'error' });
    expect(JSON.parse(init!.body as string)).toEqual({ msgtype: 'm.text', body: 'hello', 'm.mentions': {} });
  });

  it('only treats an explicit M_NOT_FOUND 404 as plaintext', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 }));
    await expect(client.roomIsPlaintext('!room:example')).resolves.toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/state/m.room.encryption/?');
    fetchImpl.mockResolvedValueOnce(Response.json({ algorithm: 'm.megolm.v1.aes-sha2' }));
    await expect(client.roomIsPlaintext('!room:example')).resolves.toBe(false);
    for (const [status, body] of [[404, {}], [403, { errcode: 'M_FORBIDDEN' }], [500, { errcode: 'M_NOT_FOUND' }]] as const) {
      fetchImpl.mockResolvedValueOnce(Response.json(body, { status }));
      await expect(client.roomIsPlaintext('!room:example')).rejects.toThrow();
    }
  });

  it('joins rooms as the bot', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ room_id: '!room:example' }));
    await client.joinRoom('!room:example');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/join/!room%3Aexample?user_id=');
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
  });

  it('registers the bot localpart without impersonation query', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ user_id: '@relay:matrix.example' }));
    await client.ensureRegistered();
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://matrix.example/proxy/_matrix/client/v3/register');
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ type: 'm.login.application_service', username: 'relay' });
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 }));
    await expect(client.ensureRegistered()).resolves.toBeUndefined();
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 }));
    await expect(client.ensureRegistered()).rejects.toThrow();
  });

  it('rejects malformed send results', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({}));
    await expect(client.sendMessage('room', 'txn', 'body')).rejects.toThrow('Invalid Matrix message response');
  });
});
