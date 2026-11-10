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

  it('reads room-specific member state with AS auth, not global profiles', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ membership: 'join', displayname: 'Room Alice', avatar_url: 'mxc://media.test/image' }));
    await expect(client.roomMember('!room:example', '@alice:example')).resolves.toEqual({ display_name: 'Room Alice', avatar_mxc: 'mxc://media.test/image' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/rooms/!room%3Aexample/state/m.room.member/%40alice%3Aexample?user_id=');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer SECRET' }, redirect: 'error' });
  });

  it.each(['', 'x'.repeat(101), 'bad\nname', null, {}, 42])('omits invalid member display names (%s)', async displayname => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ membership: 'join', displayname }));
    await expect(client.roomMember('room', '@alice:example')).resolves.toEqual({});
  });

  it.each(['https://external.test/a.png', 'mxc://host/../../secret', 'mxc://user:pass@host/a', 'mxc://host/a?token=x', 'mxc://../a', 'mxc://host/a#x', 'mxc://host/' + 'x'.repeat(2048), {}])('omits invalid or external avatar %s', async avatar_url => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ membership: 'join', avatar_url }));
    await expect(client.roomMember('room', '@alice:example')).resolves.toEqual({});
    if (typeof avatar_url === 'string') await expect(client.avatarThumbnail(avatar_url)).rejects.toThrow('Invalid Matrix avatar URI');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('fails closed on missing/left member state and fetch failures', async () => {
    const { client, fetchImpl } = setup();
    for (const body of [{}, { membership: 'leave' }, { membership: 'invite' }]) {
      fetchImpl.mockResolvedValueOnce(Response.json(body));
      await expect(client.roomMember('room', '@alice:example')).rejects.toThrow();
    }
    fetchImpl.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(client.roomMember('room', '@alice:example')).rejects.toThrow();
  });

  it('fetches authenticated thumbnails only from the configured HS, never the MXC host', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(new Response('image bytes', { headers: { 'Content-Type': 'image/png' } }));
    await expect(client.avatarThumbnail('mxc://remote.test:8448/image')).resolves.toEqual({ data: Buffer.from('image bytes').toString('base64'), content_type: 'image/png' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://matrix.example/proxy/_matrix/client/v1/media/thumbnail/remote.test%3A8448/image?width=128&height=128&method=scale');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer SECRET' }, redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it.each([
    new Response('svg', { headers: { 'Content-Type': 'image/svg+xml' } }),
    new Response('', { headers: { 'Content-Type': 'image/png' } }),
    new Response('large', { headers: { 'Content-Type': 'image/png', 'Content-Length': '1048577' } }),
    new Response(new Uint8Array(1048577), { headers: { 'Content-Type': 'image/jpeg' } }),
    new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }),
    new Response(null, { status: 204 }),
  ])('rejects unsafe thumbnail responses %#', async response => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(response);
    await expect(client.avatarThumbnail('mxc://media.test/image')).rejects.toThrow();
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

  it('registers a dedicated ghost, proves AS ownership, and refuses unknown collisions', async () => {
    const { client, fetchImpl } = setup();
    const ghost = '@relay_h_11111111111141118111111111111111:matrix.example';
    fetchImpl.mockResolvedValueOnce(Response.json({ user_id: ghost })).mockResolvedValueOnce(Response.json({ user_id: ghost }));
    await client.registerGhost(ghost, false);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).username).toBe(ghost.slice(1, ghost.indexOf(':')));
    expect(String(fetchImpl.mock.calls[1][0])).toContain('/account/whoami?user_id=');
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 }));
    await expect(client.registerGhost(ghost, false)).rejects.toThrow();
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_USER_IN_USE' }, { status: 400 })).mockResolvedValueOnce(Response.json({ user_id: ghost }));
    await expect(client.registerGhost(ghost, true)).resolves.toBeUndefined();
    await expect(client.registerGhost('@outsider:matrix.example', true)).rejects.toThrow('outside dedicated ghost namespace');
  });

  it('invites and joins ghosts with room-specific profiles, not global profiles', async () => {
    const { client, fetchImpl } = setup();
    const ghost = '@relay_h_11111111111141118111111111111111:matrix.example';
    fetchImpl.mockResolvedValueOnce(Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json({}));
    await client.joinGhost('!room:example', ghost, { displayname: 'Room Nick', avatar_url: 'mxc://matrix.example/a' });
    expect(String(fetchImpl.mock.calls[1][0])).toContain('/invite?user_id=%40relay%3A');
    expect(JSON.parse(fetchImpl.mock.calls[1][1]!.body as string)).toEqual({ user_id: ghost });
    expect(String(fetchImpl.mock.calls[2][0])).toContain(`user_id=${encodeURIComponent(ghost)}`);
    expect(JSON.parse(fetchImpl.mock.calls[3][1]!.body as string)).toEqual({ membership: 'join', displayname: 'Room Nick', avatar_url: 'mxc://matrix.example/a' });
    fetchImpl.mockResolvedValueOnce(Response.json({ event_id: '$ghost-event' }));
    await client.sendMessage('!room:example', 'txn', 'Hi Sam', { sender: ghost, userIds: ['@sam:example'], formattedBody: 'Hi <a href="https://matrix.to/#/%40sam%3Aexample">Sam</a>' });
    expect(String(fetchImpl.mock.calls[4][0])).toContain(`user_id=${encodeURIComponent(ghost)}`);
    expect(JSON.parse(fetchImpl.mock.calls[4][1]!.body as string)).toMatchObject({ 'm.mentions': { user_ids: ['@sam:example'] }, format: 'org.matrix.custom.html' });
  });

  it('preserves the room avatar when refresh bytes are unavailable, but clears an explicit removal', async () => {
    const { client, fetchImpl } = setup();
    const ghost = '@relay_h_11111111111141118111111111111111:matrix.example';
    fetchImpl.mockResolvedValueOnce(Response.json({ membership: 'join', displayname: 'Old Nick', avatar_url: 'mxc://matrix.example/old' }))
      .mockResolvedValueOnce(Response.json({}));
    await client.joinGhost('!room:example', ghost, { displayname: 'New Nick' });
    expect(JSON.parse(fetchImpl.mock.calls[1][1]!.body as string)).toEqual({ membership: 'join', displayname: 'New Nick', avatar_url: 'mxc://matrix.example/old' });
    fetchImpl.mockResolvedValueOnce(Response.json({ membership: 'join', displayname: 'New Nick', avatar_url: 'mxc://matrix.example/old' }))
      .mockResolvedValueOnce(Response.json({}));
    await client.joinGhost('!room:example', ghost, { displayname: 'New Nick', avatar_url: '' });
    expect(JSON.parse(fetchImpl.mock.calls[3][1]!.body as string).avatar_url).toBe('');
  });

  it('uploads only supplied native avatar bytes to the configured HS', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ content_uri: 'mxc://matrix.example/native' }));
    await expect(client.uploadAvatar({ data: 'aW1hZ2U=', content_type: 'image/png' })).resolves.toBe('mxc://matrix.example/native');
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://matrix.example/proxy/_matrix/media/v3/upload');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer SECRET', 'Content-Type': 'image/png' }, redirect: 'error' });
  });

  it('downloads full authenticated media only through the configured homeserver', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(new Response('file bytes', { headers: { 'Content-Type': 'application/pdf' } }));
    await expect(client.downloadFile('mxc://remote.test:8448/document', 'report.pdf'))
      .resolves.toEqual({ bytes: Buffer.from('file bytes'), name: 'report.pdf', contentType: 'application/pdf' });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://matrix.example/proxy/_matrix/client/v1/media/download/remote.test%3A8448/document');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer SECRET' }, redirect: 'error' });
  });

  it.each(['https://evil.test/file?token=SECRET', 'mxc://host/../../secret', 'mxc://user:SECRET@host/file', 'mxc://host/file?token=SECRET', 'mxc://../file'])('rejects invalid attachment URI without fetching %s', async uri => {
    const { client, fetchImpl } = setup();
    await expect(client.downloadFile(uri, 'file')).rejects.toThrow('Invalid Matrix media URI');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uploads binary media and safe Unicode names, not source URLs or JSON', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ content_uri: 'mxc://matrix.example/file' }));
    await expect(client.uploadFile({ bytes: Buffer.from('binary'), name: '../写真.pdf', contentType: 'Application/PDF; charset=binary' })).resolves.toBe('mxc://matrix.example/file');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(new URL(String(url)).searchParams.get('filename')).toBe('.._写真.pdf');
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer SECRET', 'Content-Type': 'application/pdf' }, body: Buffer.from('binary'), redirect: 'error' });
    fetchImpl.mockResolvedValueOnce(Response.json({ content_uri: 'https://evil.test/SECRET' }));
    await expect(client.uploadFile({ bytes: Buffer.alloc(0), name: 'empty.txt', contentType: 'text/plain' })).rejects.toThrow('Invalid Matrix media upload response');
  });

  it.each([['image/png', 'm.image'], ['image/apng', 'm.image'], ['image/avif', 'm.image'], ['application/pdf', 'm.file'], ['audio/ogg', 'm.file'], ['video/mp4', 'm.file']])('sends %s as %s with an idempotent ghost transaction', async (contentType, msgtype) => {
    const { client, fetchImpl } = setup();
    const sender = '@relay_h_11111111111141118111111111111111:matrix.example';
    fetchImpl.mockResolvedValue(Response.json({ event_id: '$file-event' }));
    await expect(client.sendFile('!room:example', 'source/file/2', { mxc: 'mxc://matrix.example/file', name: 'image.png', contentType, size: 123 },
      { sender, userIds: ['@sam:example'], formattedBody: '<b>not a caption</b>' })).resolves.toEqual({ event_id: '$file-event' });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/source%2Ffile%2F2?user_id=' + encodeURIComponent(sender));
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ msgtype, body: 'image.png', filename: 'image.png',
      url: 'mxc://matrix.example/file', info: { size: 123, mimetype: contentType }, 'm.mentions': {} });
  });

  it('refuses attachment sender spoofing and malformed send responses', async () => {
    const { client, fetchImpl } = setup();
    const file = { mxc: 'mxc://matrix.example/file', name: 'file', contentType: 'application/pdf', size: 0 };
    await expect(client.sendFile('room', 'txn', file, { sender: '@outsider:matrix.example' })).rejects.toThrow('outside dedicated ghost namespace');
    await expect(client.sendFile('room', 'txn', { ...file, mxc: 'https://evil.test/SECRET' })).rejects.toThrow('Invalid Matrix file');
    await expect(client.sendFile('room', 'txn', { ...file, size: 52428801 })).rejects.toThrow('Invalid Matrix file');
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValue(Response.json({}));
    await expect(client.sendFile('room', 'txn', file)).rejects.toThrow('Invalid Matrix message response');
  });

  it('rejects malformed send results', async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({}));
    await expect(client.sendMessage('room', 'txn', 'body')).rejects.toThrow('Invalid Matrix message response');
  });
});
