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
  }, 150_000);
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
    namespaces: { users: [{ exclusive: true, regex: '^@smoke_bridge:localhost$' }], aliases: [], rooms: [] },
  };
  const config = {
    server_name: serverName,
    public_baseurl: `${homeserverUrl}/`,
    pid_file: '/data/homeserver.pid',
    listeners: [{ port: synapsePort, bind_addresses: ['127.0.0.1'], type: 'http', tls: false, x_forwarded: false, resources: [{ names: ['client'], compress: false }] }],
    database: { name: 'sqlite3', args: { database: '/data/homeserver.db' } },
    media_store_path: '/data/media',
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
  let platform = null;
  let consent = true;
  let avatarUploads = 0;
  gatewayReceiver = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bot ${harmonyToken}`) { res.writeHead(401).end(); return; }
    const path = new URL(req.url, 'http://localhost').pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    let result;
    if (path.endsWith('/bridge-platform')) result = { platform };
    else if (path.includes('/bridge-consent/')) result = { relay_allowed: consent };
    else if (path.endsWith('/encryption')) result = { messages_encrypted: false };
    else if (path.endsWith('/bridge-avatar')) {
      assert.equal(input.content_type, 'image/png');
      assert.ok(Buffer.from(input.data, 'base64').length <= 1024 * 1024);
      avatarUploads++;
      result = { avatar_url: 'https://storage.example/storage/v1/object/public/avatars/bridges/bot/hash.png' };
    } else if (path.endsWith('/messages')) { harmonyPosts.push(input); result = { id: randomUUID() }; }
    else { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });
  const gatewayPort = await listen(gatewayReceiver);
  const harmony = new HarmonyClient({ apiUrl: `http://127.0.0.1:${gatewayPort}`, gatewayUrl: `ws://127.0.0.1:${gatewayPort}`, token: harmonyToken });
  const channelId = parsedConfig.pairs[0].harmonyChannelId;
  await assert.rejects(harmony.requireMatrixBridge(channelId));
  platform = 'discord';
  await assert.rejects(harmony.requireMatrixBridge(channelId));
  platform = 'matrix';
  await harmony.requireMatrixBridge(channelId);
  relayStore = new Store(':memory:');
  const relay = new Relay(parsedConfig, relayStore, harmony, matrix);
  relay.acceptTransaction('human', [events.get(incoming.event_id)]);
  await relay.tick();
  assert.equal(harmonyPosts.length, 1);
  assert.deepEqual(harmonyPosts[0].content, [{ type: 'text', text: 'Human plaintext smoke check' }]);
  assert.deepEqual(harmonyPosts[0].metadata.bridge_author, { platform: 'matrix', id: user.user_id, username, display_name: 'Room Human',
    avatar_url: 'https://storage.example/storage/v1/object/public/avatars/bridges/bot/hash.png' });
  assert.equal(avatarUploads, 1);
  const nativeMessage = id => ({ id, channel_id: channelId, author: { id: parsedConfig.harmony.allowedUserIds[0], username: 'Harmony Human' },
    content: 'Native consent check', metadata: {} });
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

  stage = 'encrypted-room detection';
  await json(`${roomPath}/state/m.room.encryption/`, {
    method: 'PUT', token: user.access_token, body: { algorithm: 'm.megolm.v1.aes-sha2' },
  });
  assert.equal(await matrix.roomIsPlaintext(roomId), false);
  relay.acceptTransaction('encrypted', [{ ...events.get(incoming.event_id), event_id: '$blocked' }]);
  await relay.tick();
  assert.equal(harmonyPosts.length, 1);
  assert.equal(avatarUploads, 1);
  assert.equal(relayStore.counts().failed, 2);
  console.log('PASS encrypted-room relay guard (no additional text/avatar upload)');
  console.log('PASS roomIsPlaintext returns false after encryption state is enabled');
  console.log('PASS real Synapse smoke complete (plaintext only; no E2EE relay/decryption claimed)');
}

try {
  await main();
} catch (error) {
  // Known local prerequisite failures are safe; everything else is stage-only.
  const safe = ['Run npm run build first (dist/MatrixClient.js is missing)', 'Docker is unavailable; install/start Docker and allow this user access', 'Linux Docker host networking is required'];
  console.error(`FAIL during ${stage}${safe.includes(error?.message) ? `: ${error.message}` : ' (details suppressed to protect temporary credentials)'}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
