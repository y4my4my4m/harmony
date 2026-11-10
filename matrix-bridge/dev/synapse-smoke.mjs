#!/usr/bin/env node
// Opt-in Linux/Docker integration check. Run `npm run build` first, then
// `node dev/synapse-smoke.mjs`. Never uses an existing homeserver or its secrets.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createMediaGateway, runMediaSmoke, MEDIA_LIMIT } from './media-smoke.mjs';

const exec = promisify(execFile);
const image = 'ghcr.io/element-hq/synapse:latest';
const runId = randomUUID();
const name = `harmony-matrix-smoke-${runId}`;
const label = 'org.harmony.matrix-bridge.smoke';
const secret = () => randomBytes(32).toString('hex');
const asToken = secret();
const hsToken = secret();
const registrationSecret = secret();
const password = secret();
const serverName = 'localhost';
const botUserId = `@smoke_bridge:${serverName}`;
const username = `human_${randomBytes(6).toString('hex')}`;
const events = new Map();
let directory;
let receiver;
let gatewayReceiver;
let relayStore;
let harmonyConnection;
let gatewaySockets;
let deadline;
let stage = 'prerequisites';
let shuttingDown = false;
let pendingContainerStart;
let cleanupPromise;
const controller = new AbortController();

async function docker(args, timeout = 20_000) {
  return exec('docker', args, { timeout, maxBuffer: 2 * 1024 * 1024 });
}

function fail(message) {
  // Only harness-authored messages reach stdout/stderr; never dump API bodies,
  // Docker stderr, assertion diagnostics, or exception causes containing tokens.
  throw new Error(message);
}

async function json(url, { method = 'GET', token, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) fail(`HTTP ${response.status}`);
  return response.json();
}

async function until(check, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    controller.signal.throwIfAborted();
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  fail('Operation timed out');
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startReceiver() {
  const { createAppService } = await import('../dist/AppService.js');
  receiver = createAppService({
    hsToken, botUserId,
    acceptTransaction: (_id, transactionEvents) => {
      // Use the production HTTP/authentication/validation handler, not a permissive fake.
      for (const event of transactionEvents) {
        if (typeof event.event_id === 'string') events.set(event.event_id, event);
      }
      return true;
    },
    status: () => ({ ready: true, pending: 0, failed: 0 }),
  });
  return listen(receiver);
}

function cleanup() {
  return cleanupPromise ??= performCleanup();
}

async function performCleanup() {
  shuttingDown = true;
  controller.abort();
  clearTimeout(deadline);
  // Wait for an in-flight, bounded `docker run` before checking for its result.
  // Only an exact name AND unique label match permits removal.
  if (pendingContainerStart) await pendingContainerStart.catch(() => {});
  let removed = true;
  try {
    const owned = await docker(['ps', '--all', '--filter', `label=${label}=${runId}`, '--filter', `name=${name}`, '--format', '{{.Names}}']);
    if (owned.stdout.trim() === name) await docker(['rm', '--force', name]);
  } catch {
    // If Docker became unavailable after run, retain the mounted private data.
    removed = !pendingContainerStart;
  }
  if (receiver) {
    receiver.closeAllConnections();
    await new Promise(resolve => receiver.close(resolve));
  }
  harmonyConnection?.stop();
  if (gatewaySockets) { for (const socket of gatewaySockets.clients) socket.terminate(); gatewaySockets.close(); }
  if (gatewayReceiver) {
    gatewayReceiver.closeAllConnections();
    await new Promise(resolve => gatewayReceiver.close(resolve));
  }
  relayStore?.close();
  if (directory && removed) await rm(directory, { recursive: true, force: true });
  if (!removed) console.error(`Cleanup could not remove own container ${name}; private temporary files retained until it is removed.`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (shuttingDown) return;
    controller.abort();
    void cleanup().finally(() => process.exit(1));
  });
}

async function main() {
  if (process.platform !== 'linux') fail('Linux Docker host networking is required');
  await access(new URL('../dist/MatrixClient.js', import.meta.url)).catch(() => fail('Run npm run build first (dist/MatrixClient.js is missing)'));
  await docker(['version', '--format', '{{.Server.Version}}']).catch(() => fail('Docker is unavailable; install/start Docker and allow this user access'));
  const { MatrixClient } = await import('../dist/MatrixClient.js');
  const { configSchema } = await import('../dist/config.js');
  console.log('Pulling opt-in Synapse smoke image (no shared containers are changed)...');
  stage = 'image pull';
  await docker(['pull', image], 240_000);
  const { stdout } = await docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', image]);
  const digest = JSON.parse(stdout).find(value => /^ghcr\.io\/element-hq\/synapse@sha256:[a-f0-9]{64}$/.test(value));
  if (!digest) fail('Could not determine pulled Synapse image digest');
  console.log(`Synapse image: ${digest}`);

  // This deadline covers startup, test requests, and delivery waits, not pulling.
  deadline = setTimeout(() => {
    if (shuttingDown) return;
    console.error(`FAIL during ${stage}: smoke deadline exceeded`);
    void cleanup().finally(() => process.exit(1));
  }, 240_000);
  stage = 'private configuration';
  directory = await mkdtemp(join(tmpdir(), 'harmony-matrix-smoke-'));
  await chmod(directory, 0o700);
  const receiverPort = await startReceiver();
  // Verify that the production AS handler does not count unauthenticated traffic as delivery.
  const rejected = await fetch(`http://127.0.0.1:${receiverPort}/_matrix/app/v1/transactions/unauthenticated`, {
    method: 'PUT', body: JSON.stringify({ events: [{ event_id: '$unauthenticated' }] }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  assert.equal(rejected.status, 401);
  await rejected.arrayBuffer();
  assert.equal(events.size, 0);
  const synapsePort = await freePort();
  const homeserverUrl = `http://127.0.0.1:${synapsePort}`;
  const registration = {
    id: runId,
    url: `http://127.0.0.1:${receiverPort}`,
    as_token: asToken,
    hs_token: hsToken,
    sender_localpart: 'smoke_bridge',
    rate_limited: false,
    namespaces: { users: [{ exclusive: true, regex: '^@smoke_bridge:localhost$' }, { exclusive: true, regex: '^@smoke_bridge_h_[0-9a-f]{32}:localhost$' }], aliases: [], rooms: [] },
  };
  const config = {
    server_name: serverName,
    public_baseurl: `${homeserverUrl}/`,
    pid_file: '/data/homeserver.pid',
    listeners: [{ port: synapsePort, bind_addresses: ['127.0.0.1'], type: 'http', tls: false, x_forwarded: false, resources: [{ names: ['client'], compress: false }] }],
    database: { name: 'sqlite3', args: { database: '/data/homeserver.db' } },
    media_store_path: '/data/media',
    // Permit an actual over-limit fixture; the bridge must enforce its own 50 MiB cap.
    max_upload_size: '52M',
    signing_key_path: '/data/signing.key',
    macaroon_secret_key: secret(),
    form_secret: secret(),
    registration_shared_secret: registrationSecret,
    enable_registration: false,
    report_stats: false,
    trusted_key_servers: [],
    suppress_key_server_warning: true,
    app_service_config_files: ['/data/registration.json'],
    encryption_enabled_by_default_for_room_type: 'off',
    // The isolated smoke sends a short burst of real human reply/edit/thread events.
    rc_message: { per_second: 100, burst_count: 100 },
  };
  await writeFile(join(directory, 'registration.json'), JSON.stringify(registration), { mode: 0o600 });
  // YAML accepts JSON, so this requires no YAML/npm dependency.
  await writeFile(join(directory, 'homeserver.yaml'), JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(directory, 'signing.key'), `ed25519 smoke ${randomBytes(32).toString('base64').replace(/=+$/, '')}\n`, { mode: 0o600 });

  stage = 'Synapse startup';
  pendingContainerStart = docker([
    'run', '--detach', '--rm', '--name', name, '--label', `${label}=${runId}`,
    '--network', 'host', '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,source=${directory},target=/data`,
    '--entrypoint', 'python', digest,
    '-m', 'synapse.app.homeserver', '--config-path', '/data/homeserver.yaml',
  ]);
  await pendingContainerStart;
  await until(async () => {
    try { await json(`${homeserverUrl}/_matrix/client/versions`); return true; }
    catch { return false; }
  }, 60_000);

  stage = 'admin registration';
  const { nonce } = await json(`${homeserverUrl}/_synapse/admin/v1/register`);
  const mac = createHmac('sha1', registrationSecret).update(`${nonce}\0${username}\0${password}\0notadmin`).digest('hex');
  const user = await json(`${homeserverUrl}/_synapse/admin/v1/register`, {
    method: 'POST', body: { nonce, username, password, admin: false, mac },
  });
  assert.equal(typeof user.access_token, 'string');
  const matrix = new MatrixClient({ homeserverUrl, asToken, botUserId });

  stage = 'ensureRegistered';
  await matrix.ensureRegistered();
  await matrix.ensureRegistered(); // Existing bot is explicitly allowed.
  console.log('PASS ensureRegistered (including already-registered bot)');

  stage = 'room creation and join';
  const { room_id: roomId } = await json(`${homeserverUrl}/_matrix/client/v3/createRoom`, {
    method: 'POST', token: user.access_token,
    body: { preset: 'private_chat', invite: [botUserId], creation_content: { 'm.federate': false } },
  });
  assert.equal(typeof roomId, 'string');
  // Exercise configuration too: modern room versions use opaque IDs without ':server'.
  const parsedConfig = configSchema.parse({
    harmony: {
      apiUrl: 'http://127.0.0.1:3002', gatewayUrl: 'ws://127.0.0.1:3002/gateway',
      allowedUserIds: ['11111111-1111-4111-8111-111111111111'],
    },
    matrix: {
      homeserverUrl, serverName, senderLocalpart: 'smoke_bridge',
      applicationServiceUrl: registration.url, allowedUserIds: [user.user_id],
    },
    pairs: [{ harmonyChannelId: '22222222-2222-4222-8222-222222222222', matrixRoomId: roomId }],
  });
  assert.equal(parsedConfig.pairs[0].matrixRoomId, roomId);
  console.log('PASS configuration accepts actual homeserver room ID');
  await matrix.joinRoom(roomId);
  assert.equal(await matrix.roomIsPlaintext(roomId), true);
  console.log('PASS joinRoom and roomIsPlaintext (real M_NOT_FOUND state response)');

  stage = 'Matrix send and idempotent transaction';
  const txn = randomUUID();
  const body = 'Plaintext smoke check: @room (no mentions)';
  const sent = await matrix.sendMessage(roomId, txn, body);
  const duplicate = await matrix.sendMessage(roomId, txn, body);
  assert.equal(sent.event_id, duplicate.event_id);
  const roomPath = `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
  const event = await json(`${roomPath}/event/${encodeURIComponent(sent.event_id)}`, { token: user.access_token });
  assert.equal(event.sender, botUserId);
  assert.equal(event.content.body, body);
  assert.equal(event.content.msgtype, 'm.text');
  assert.deepEqual(event.content['m.mentions'], {});
  await until(() => events.has(sent.event_id));
  assert.equal(events.get(sent.event_id).content.body, body);
  console.log('PASS sendMessage, transaction idempotency, no-mention payload, authenticated AS delivery');

  stage = 'human-to-application-service delivery';
  const incoming = await json(`${roomPath}/send/m.room.message/${randomUUID()}`, {
    method: 'PUT', token: user.access_token,
    body: { msgtype: 'm.text', body: 'Human plaintext smoke check', 'm.mentions': {} },
  });
  await until(() => events.has(incoming.event_id));
  assert.equal(events.get(incoming.event_id).sender, user.user_id);
  assert.equal(events.get(incoming.event_id).content.body, 'Human plaintext smoke check');
  console.log('PASS authenticated inbound AS message transaction');

  stage = 'room-specific profile and authenticated avatar';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const mediaResponse = await fetch(`${homeserverUrl}/_matrix/media/v3/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${user.access_token}`, 'Content-Type': 'image/png' }, body: png,
    redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  assert.equal(mediaResponse.ok, true);
  const { content_uri: avatarMxc } = await mediaResponse.json();
  await json(`${roomPath}/state/m.room.member/${encodeURIComponent(user.user_id)}`, {
    method: 'PUT', token: user.access_token,
    body: { membership: 'join', displayname: 'Room Human', avatar_url: avatarMxc },
  });
  assert.deepEqual(await matrix.roomMember(roomId, user.user_id), { display_name: 'Room Human', avatar_mxc: avatarMxc });
  const thumbnail = await matrix.avatarThumbnail(avatarMxc);
  assert.equal(thumbnail.content_type, 'image/png');
  assert.ok(Buffer.from(thumbnail.data, 'base64').length <= 1024 * 1024);
  console.log('PASS real room-member state and AS-authenticated media thumbnail');

  stage = 'Gateway registration/consent/avatar contract and queued relay';
  // Only Gateway is a contract fake: all Matrix membership/media/send/encryption calls use real Synapse.
  const { HarmonyClient } = await import('../dist/HarmonyClient.js');
  const { Relay } = await import('../dist/Relay.js');
  const { Store } = await import('../dist/Store.js');
  const harmonyToken = secret();
  const harmonyPosts = [];
  const harmonyMessages = new Map();
  let platform = null;
  let consent = true;
  let senderMode = 'relay';
  let bound = false;
  let nativeEncrypted = false;
  const channelId = parsedConfig.pairs[0].harmonyChannelId;
  const mediaGateway = createMediaGateway(channelId, () => platform === 'matrix' && consent && !nativeEncrypted);
  const gatewayErrors = [];
  const optedOut = new Set();
  const nativeUsers = [{ id: parsedConfig.harmony.allowedUserIds[0], username: 'alice', display_name: 'Alice Room Nick', avatar_url: 'https://never-fetch.invalid/alice.png', domain: 'harmony.test' },
    { id: '33333333-3333-4333-8333-333333333333', username: 'bob', display_name: 'Bob Room Nick', avatar_url: null, domain: 'harmony.test' }];
  parsedConfig.harmony.allowedUserIds.push(nativeUsers[1].id);
  let avatarUploads = 0;
  let nativeAvatarReads = 0;
  const memberFrames = [];
  gatewayReceiver = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bot ${harmonyToken}`) { res.writeHead(401).end(); return; }
    try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MEDIA_LIMIT) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (await mediaGateway.handle(req, res, path, bytes)) return;
    const input = bytes.length ? JSON.parse(bytes.toString()) : {};
    let result;
    if (path.endsWith('/bridge-platform')) result = { platform };
    else if (path.endsWith('/bridge-room')) {
      if (req.method === 'PUT' && !bound) { bound = true; senderMode = input.initial_sender_mode; }
      result = { room_id: roomId, sender_mode: senderMode };
    }
    else if (path.endsWith('/bridge-members')) result = consent ? nativeUsers.filter(member => !optedOut.has(member.id)) : [];
    else if (/\/bridge-members\/[^/]+\/avatar$/.test(path)) { nativeAvatarReads++; result = { data: png.toString('base64'), content_type: 'image/png' }; }
    else if (path.includes('/bridge-consent/')) result = { relay_allowed: consent && !optedOut.has(path.split('/').at(-1)) };
    else if (path.endsWith('/encryption')) result = { messages_encrypted: nativeEncrypted };
    else if (path.endsWith('/bridge-avatar')) {
      assert.equal(input.content_type, 'image/png');
      assert.ok(Buffer.from(input.data, 'base64').length <= 1024 * 1024);
      avatarUploads++;
      result = { avatar_url: 'https://storage.example/storage/v1/object/public/avatars/bridges/bot/hash.png' };
    } else if (path.endsWith('/messages') && req.method === 'POST') {
      harmonyPosts.push(input);
      result = { id: randomUUID() };
      harmonyMessages.set(result.id, { id: result.id, channel_id: channelId, content_raw: input.content });
    } else if (/\/messages\/[^/]+$/.test(path) && req.method === 'GET') {
      result = harmonyMessages.get(decodeURIComponent(path.split('/').at(-1)));
      if (!result) { res.writeHead(404).end(); return; }
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      gatewayErrors.push('Invalid fake Gateway request');
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  gatewaySockets = new WebSocketServer({ server: gatewayReceiver });
  gatewaySockets.on('connection', socket => socket.on('message', bytes => {
    const frame = JSON.parse(bytes.toString());
    if (frame.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', d: { heartbeat_interval: 1000 } }));
    if (frame.op === 1) socket.send('{"op":11}');
    if (frame.op === 6) memberFrames.push(frame.d);
  }));
  const gatewayPort = await listen(gatewayReceiver);
  const harmony = new HarmonyClient({ apiUrl: `http://127.0.0.1:${gatewayPort}`, gatewayUrl: `ws://127.0.0.1:${gatewayPort}`, token: harmonyToken });
  harmonyConnection = harmony;
  await assert.rejects(harmony.requireMatrixBridge(channelId));
  platform = 'discord';
  await assert.rejects(harmony.requireMatrixBridge(channelId));
  platform = 'matrix';
  await harmony.requireMatrixBridge(channelId);
  await harmony.bridgeRoom(channelId, { room_id: roomId, initial_sender_mode: 'relay' });
  assert.equal((await harmony.bridgeRoom(channelId, { room_id: roomId, initial_sender_mode: 'ghost' })).sender_mode, 'relay');
  const connected = once(harmony, 'ready');
  harmony.start();
  await connected;
  const storePath = join(directory, 'relay.sqlite');
  relayStore = new Store(storePath);
  let relay = new Relay(parsedConfig, relayStore, harmony, matrix);
  relay.acceptTransaction('human', [events.get(incoming.event_id)]);
  await relay.tick();
  assert.equal(harmonyPosts.length, 1);
  assert.deepEqual(harmonyPosts[0].content, [{ type: 'text', text: 'Human plaintext smoke check' }]);
  assert.deepEqual(harmonyPosts[0].metadata.bridge_author, { platform: 'matrix', id: user.user_id, username, display_name: 'Room Human',
    avatar_url: 'https://storage.example/storage/v1/object/public/avatars/bridges/bot/hash.png' });
  assert.equal(avatarUploads, 1);
  const nativeMessage = id => {
    harmonyMessages.set(id, { id, channel_id: channelId });
    return { id, channel_id: channelId, author: { id: parsedConfig.harmony.allowedUserIds[0], username: 'Harmony Human' },
      content: 'Native consent check', metadata: {} };
  };
  relay.acceptHarmonyMessage(nativeMessage('opted-out'));
  consent = false; // Changed AFTER enqueue, before delivery.
  await relay.tick();
  assert.equal(relayStore.findMapping('to_matrix', 'opted-out', channelId, roomId), null);
  assert.equal(relayStore.counts().failed, 1);
  consent = true;
  relay.acceptHarmonyMessage(nativeMessage('allowed'));
  await relay.tick();
  const destinationId = relayStore.findMapping('to_matrix', 'allowed', channelId, roomId);
  assert.equal(typeof destinationId, 'string');
  const relayed = await json(`${roomPath}/event/${encodeURIComponent(destinationId)}`, { token: user.access_token });
  assert.equal(relayed.sender, botUserId);
  assert.equal(relayed.content.body, '[Harmony Human · Harmony] Native consent check');
  console.log('PASS Gateway contract: Matrix registration required, generalized authors, avatar upload, queued opt-out, single AS sender');

  stage = 'two actual ghosts, room profiles, member autocomplete and real mentions';
  const { ghostUserId } = await import('../dist/config.js');
  const { HttpError } = await import('../dist/http.js');
  senderMode = 'ghost'; // Administrative DB mode overrides the relay config default.
  relay.requestMemberSync();
  await relay.tick();
  const aliceGhost = ghostUserId(parsedConfig, nativeUsers[0].id);
  const bobGhost = ghostUserId(parsedConfig, nativeUsers[1].id);
  const joined = await matrix.roomMembers(roomId);
  assert.ok(joined.some(member => member.id === aliceGhost));
  assert.ok(joined.some(member => member.id === bobGhost));
  const aliceProfile = await matrix.roomMember(roomId, aliceGhost);
  assert.equal(aliceProfile.display_name, 'Alice Room Nick');
  assert.ok(aliceProfile.avatar_mxc.startsWith('mxc://'));
  assert.equal((await matrix.roomMember(roomId, bobGhost)).display_name, 'Bob Room Nick');
  assert.equal(nativeAvatarReads, 1);
  await until(() => memberFrames.length > 0);
  assert.deepEqual(memberFrames.at(-1).channels[0].members.map(member => member.id), [user.user_id]);

  const sendActual = matrix.sendMessage.bind(matrix);
  let lostResponseId;
  let loseNextResponse = true;
  let sendAttempts = 0;
  matrix.sendMessage = async (...args) => {
    sendAttempts++;
    const result = await sendActual(...args);
    if (loseNextResponse) { loseNextResponse = false; lostResponseId = result.event_id; throw new HttpError('Simulated lost Matrix response', true, 503); }
    return result;
  };
  relay.acceptHarmonyMessage({ ...nativeMessage('ghost-idempotent'), content_raw: [{ type: 'text', text: 'Hi ' },
    { type: 'mention', userId: user.user_id, username, domain: serverName, isLocal: false, isBridged: true, bridgeSource: 'matrix' }] });
  await relay.tick();
  await until(() => relayStore.nextJob() !== null);
  await relay.tick();
  const ghostEventId = relayStore.findMapping('to_matrix', 'ghost-idempotent', channelId, roomId);
  assert.equal(ghostEventId, lostResponseId);
  assert.equal(sendAttempts, 2);
  const ghostEvent = await json(`${roomPath}/event/${encodeURIComponent(ghostEventId)}`, { token: user.access_token });
  assert.equal(ghostEvent.sender, aliceGhost);
  assert.equal(ghostEvent.content.body, `Hi @${username}`);
  assert.deepEqual(ghostEvent.content['m.mentions'], { user_ids: [user.user_id] });
  assert.ok(ghostEvent.content.formatted_body.includes(`https://matrix.to/#/${encodeURIComponent(user.user_id)}`));
  // Echo exclusion applies to the whole owned namespace, even if someone adds a ghost to the source allowlist.
  parsedConfig.matrix.allowedUserIds.push(aliceGhost);
  relay.acceptTransaction('ghost-echo', [{ ...ghostEvent, room_id: roomId }]);
  await relay.tick();
  assert.equal(harmonyPosts.length, 1);

  const mentioned = await json(`${roomPath}/send/m.room.message/${randomUUID()}`, {
    method: 'PUT', token: user.access_token, body: { msgtype: 'm.text', body: 'Hello Bob Room Nick',
      format: 'org.matrix.custom.html', formatted_body: `Hello <a href="https://matrix.to/#/${encodeURIComponent(bobGhost)}">Bob Room Nick</a>`,
      'm.mentions': { user_ids: [bobGhost] } },
  });
  await until(() => events.has(mentioned.event_id));
  relay.acceptTransaction('human', [events.get(mentioned.event_id)]); // Simulate HS counter reuse with a different real event.
  await relay.tick();
  assert.deepEqual(harmonyPosts.at(-1).content, [{ type: 'text', text: 'Hello ' },
    { type: 'mention', userId: nativeUsers[1].id, username: 'bob', domain: 'harmony.test', isLocal: true, isBridged: false }]);
  console.log('PASS two real AS ghosts before speech, room nickname/avatar, allowlisted WS members, unprefixed text, idempotency and real mentions both ways');

  stage = 'ghost opt-out and administrator sender-mode transition';
  optedOut.add(nativeUsers[0].id);
  relay.acceptHarmonyMessage(nativeMessage('ghost-opted-out'));
  relay.requestMemberSync();
  await relay.tick();
  assert.ok(!(await matrix.roomMembers(roomId)).some(member => member.id === aliceGhost));
  assert.equal(relayStore.findMapping('to_matrix', 'ghost-opted-out', channelId, roomId), null);
  optedOut.clear();
  loseNextResponse = true;
  relay.acceptHarmonyMessage(nativeMessage('mode-frozen'));
  await relay.tick();
  const attemptsBeforeSwitch = sendAttempts;
  senderMode = 'relay';
  await until(() => relayStore.nextJob() !== null);
  relay.requestMemberSync();
  await relay.tick();
  assert.equal(sendAttempts, attemptsBeforeSwitch); // No resend from a different sender after an uncertain response.
  assert.ok(!(await matrix.roomMembers(roomId)).some(member => member.id === aliceGhost || member.id === bobGhost));
  assert.equal((await json(`${roomPath}/event/${encodeURIComponent(ghostEventId)}`, { token: user.access_token })).sender, aliceGhost);
  const command = await json(`${roomPath}/send/m.room.message/${randomUUID()}`, {
    method: 'PUT', token: user.access_token, body: { msgtype: 'm.text', body: '!mention bob relay mode ping', 'm.mentions': {} },
  });
  await until(() => events.has(command.event_id));
  relay.acceptTransaction('relay-command', [events.get(command.event_id)]);
  await relay.tick();
  assert.equal(harmonyPosts.at(-1).content[0].userId, nativeUsers[1].id);
  relay.acceptHarmonyMessage(nativeMessage('relay-again'));
  await relay.tick();
  const relayAgain = await json(`${roomPath}/event/${encodeURIComponent(relayStore.findMapping('to_matrix', 'relay-again', channelId, roomId))}`, { token: user.access_token });
  assert.equal(relayAgain.sender, botUserId);
  assert.equal(relayAgain.content.body, '[Harmony Human · Harmony] Native consent check');
  console.log('PASS opted-out ghost leaves, relay mode removes ghosts without deleting history, frozen sender refuses cross-mode retry, exact !mention command');

  stage = 'real Matrix rich replies to both origins and unmapped parents';
  const matrixParentCopy = relayStore.findMapping('to_harmony', incoming.event_id, channelId, roomId);
  assert.equal(typeof matrixParentCopy, 'string');
  async function incomingReply(parentId, cleanBody, expectedReplyTo, withFallback = true) {
    const before = harmonyPosts.length;
    const reply = await json(`${roomPath}/send/m.room.message/${randomUUID()}`, {
      method: 'PUT', token: user.access_token, body: { msgtype: 'm.text',
        body: withFallback ? `> <${user.user_id}> quoted original\n> second quoted line\n\n${cleanBody}` : cleanBody,
        ...(withFallback ? { format: 'org.matrix.custom.html',
          formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${encodeURIComponent(parentId)}">In reply to</a> quoted original</blockquote></mx-reply>${cleanBody}` } : {}),
        'm.relates_to': { 'm.in_reply_to': { event_id: parentId } }, 'm.mentions': {} },
    });
    await until(() => events.has(reply.event_id));
    relay.acceptTransaction(randomUUID(), [events.get(reply.event_id)]);
    await relay.tick();
    assert.equal(harmonyPosts.length, before + 1);
    const posted = harmonyPosts.at(-1);
    assert.deepEqual(posted.content, [{ type: 'text', text: cleanBody }]);
    if (expectedReplyTo) assert.equal(posted.reply_to, expectedReplyTo);
    else assert.ok(!posted.reply_to);
    assert.ok(!JSON.stringify(posted.content).includes('quoted original'));
    assert.ok(!JSON.stringify(posted.content).includes('mx-reply'));
    return reply.event_id;
  }
  // Matrix-origin parent: forward lookup gives its native Harmony copy.
  await incomingReply(incoming.event_id, 'Thats a wave :)', matrixParentCopy);
  // Harmony-origin parent: reverse lookup of the real Matrix copy gives the native source.
  await incomingReply(destinationId, 'Reply to native Harmony original', 'allowed');
  // Real Matrix parent never accepted by this relay: preserve a bare reply as clean text.
  const unmapped = await json(`${roomPath}/send/m.room.message/${randomUUID()}`, {
    method: 'PUT', token: user.access_token, body: { msgtype: 'm.text', body: 'Unmapped Matrix original', 'm.mentions': {} },
  });
  await incomingReply(unmapped.event_id, 'Bare unmapped reply survives', undefined, false);
  // A stored mapping is not permission: a parent returned in another channel must not attach.
  const originalParent = harmonyMessages.get(matrixParentCopy);
  harmonyMessages.set(matrixParentCopy, { ...originalParent, channel_id: '99999999-9999-4999-8999-999999999999' });
  await incomingReply(incoming.event_id, 'Ineligible parent falls back to clean text', undefined);
  harmonyMessages.set(matrixParentCopy, originalParent);
  console.log('PASS real Matrix replies resolve both parent origins, strip plain/HTML quote fallbacks, and preserve unmapped/ineligible replies as clean text');

  stage = 'real Matrix edits and threads remain ignored';
  const ignoredRelations = [
    { msgtype: 'm.text', body: '* Edited original', 'm.new_content': { msgtype: 'm.text', body: 'Edited original' },
      'm.relates_to': { rel_type: 'm.replace', event_id: incoming.event_id } },
    { msgtype: 'm.text', body: 'Thread reply must not relay',
      'm.relates_to': { rel_type: 'm.thread', event_id: incoming.event_id, 'm.in_reply_to': { event_id: incoming.event_id } } },
  ];
  const ignoredEvents = [];
  for (const content of ignoredRelations) {
    stage = content['m.relates_to'].rel_type === 'm.replace' ? 'real Matrix edit submission' : 'real Matrix thread submission';
    const ignored = await json(`${roomPath}/send/m.room.message/${randomUUID()}`, {
      method: 'PUT', token: user.access_token, body: content,
    });
    stage = content['m.relates_to'].rel_type === 'm.replace' ? 'real Matrix edit AS delivery' : 'real Matrix thread AS delivery';
    await until(() => events.has(ignored.event_id));
    ignoredEvents.push(events.get(ignored.event_id));
  }
  stage = 'real Matrix edit/thread relay rejection';
  const beforeIgnored = harmonyPosts.length;
  const countsBeforeIgnored = relayStore.counts();
  relay.acceptTransaction(randomUUID(), ignoredEvents);
  assert.deepEqual(relayStore.counts(), countsBeforeIgnored);
  await relay.tick();
  assert.equal(harmonyPosts.length, beforeIgnored);
  console.log('PASS actual Matrix edit/thread events are ignored (including thread m.in_reply_to)');

  const mediaResult = await runMediaSmoke({ matrix, harmony, config: parsedConfig, gateway: mediaGateway, events, json, until,
    homeserverUrl, roomPath, roomId, user, png, harmonyPosts, harmonyMessages, nativeMessage, channelId, botUserId,
    getRelay: () => relay, getStore: () => relayStore,
    restart: async () => {
      await relay.stop();
      relayStore.close();
      relayStore = new Store(storePath);
      relay = new Relay(parsedConfig, relayStore, harmony, matrix);
    },
    setConsent: value => { consent = value; },
    setNativeEncryption: value => { nativeEncrypted = value; },
    setStage: value => { stage = value; }, signal: controller.signal,
  });
  assert.deepEqual(gatewayErrors, []);

  mediaResult.enqueueNativeFence();
  const mediaReadsBeforeEncryption = mediaGateway.reads.length;
  const mediaWritesBeforeEncryption = mediaGateway.writes.length;
  let matrixMediaAfterEncryption = 0;
  const mediaMethods = {};
  for (const method of ['downloadFile', 'uploadFile', 'sendFile']) {
    mediaMethods[method] = matrix[method].bind(matrix);
    matrix[method] = (...args) => { matrixMediaAfterEncryption++; return mediaMethods[method](...args); };
  }
  const postsBeforeEncryption = harmonyPosts.length;
  const avatarsBeforeEncryption = avatarUploads;
  const failedBeforeEncryption = relayStore.counts().failed;
  stage = 'encrypted-room detection';
  const encryption = await json(`${roomPath}/state/m.room.encryption/`, {
    method: 'PUT', token: user.access_token, body: { algorithm: 'm.megolm.v1.aes-sha2' },
  });
  await until(() => events.has(encryption.event_id));
  assert.equal(await matrix.roomIsPlaintext(roomId), false);
  relay.acceptTransaction('human', [events.get(encryption.event_id),
    { ...events.get(incoming.event_id), event_id: '$blocked' }, mediaResult.fenceEvent]);
  assert.equal(relayStore.isRoomBlocked(roomId), true);
  await relay.tick();
  await relay.tick();
  await relay.tick();
  assert.equal(harmonyPosts.length, postsBeforeEncryption);
  assert.equal(avatarUploads, avatarsBeforeEncryption);
  assert.equal(relayStore.counts().failed, failedBeforeEncryption + 3);
  assert.equal(mediaGateway.reads.length, mediaReadsBeforeEncryption);
  assert.equal(mediaGateway.writes.length, mediaWritesBeforeEncryption);
  assert.equal(matrixMediaAfterEncryption, 0);
  Object.assign(matrix, mediaMethods);
  console.log('PASS reused AS transaction ID accepts distinct real events and a new durable encryption fence');
  console.log('PASS encrypted-room relay guard (no additional text/avatar upload)');
  console.log('PASS actual room encryption fences queued files in both directions before media download, upload or send');
  console.log('PASS roomIsPlaintext returns false after encryption state is enabled');
  console.log('PASS real Synapse smoke complete (plaintext only; no E2EE relay/decryption claimed)');
}

try {
  await main();
} catch (error) {
  // Known local prerequisite failures are safe; everything else is stage-only.
  const safe = ['Run npm run build first (dist/MatrixClient.js is missing)', 'Docker is unavailable; install/start Docker and allow this user access', 'Linux Docker host networking is required'];
  console.error(`FAIL during ${stage}${safe.includes(error?.message) || /^HTTP [0-9]{3}$/.test(error?.message ?? '') ? `: ${error.message}` : ' (details suppressed to protect temporary credentials)'}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
