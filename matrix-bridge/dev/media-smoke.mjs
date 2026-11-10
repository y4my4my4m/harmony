// Real Synapse media checks, invoked by synapse-smoke.mjs only. No Docker resources here.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const MEDIA_LIMIT = 50 * 1024 * 1024;

/** The only fake transport: Gateway stores channel-scoped private bytes, never external URLs. */
export function createMediaGateway(channelId, permitted) {
  const uploads = new Map();
  const sources = new Map();
  const reads = [];
  const writes = [];
  const errors = [];
  let failReads = false;
  let failWrites = false;
  let afterRead;
  let afterWrite;
  return {
    uploads, reads, writes, errors,
    source(messageId, rawIndex, file) { sources.set(`${messageId}:${rawIndex}`, file); },
    failReads(value) { failReads = value; },
    failWrites(value) { failWrites = value; },
    afterRead(fn) { afterRead = fn; },
    afterWrite(fn) { afterWrite = fn; },
    async handle(req, res, path, bytes) {
      const root = `/channels/${channelId}`;
      const route = path.replace(/^\/api\/v1(?=\/)/, '');
      const read = new RegExp(`^${root}/messages/([^/]+)/bridge-files/([0-9]+)$`).exec(route);
      if (route !== `${root}/bridge-files` && !read) return false;
      try {
        if (!permitted()) { res.writeHead(403).end(); return true; }
        if (read && req.method === 'GET') {
          reads.push({ messageId: decodeURIComponent(read[1]), index: Number(read[2]) });
          const file = sources.get(`${decodeURIComponent(read[1])}:${Number(read[2])}`);
          if (failReads || !file) { res.writeHead(404).end(); return true; }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.bytes.length,
            'X-File-Name': encodeURIComponent(file.name), 'X-File-Type': file.contentType });
          res.end(file.bytes);
          afterRead?.();
          return true;
        }
        if (route === `${root}/bridge-files` && req.method === 'POST') {
          if (failWrites) { res.writeHead(400).end(); return true; }
          assert.equal(req.headers['content-type'], 'application/octet-stream');
          assert.ok(bytes.length > 0 && bytes.length <= MEDIA_LIMIT);
          assert.equal(typeof req.headers['x-file-name'], 'string');
          const name = decodeURIComponent(req.headers['x-file-name']);
          const contentType = req.headers['x-file-type'];
          assert.ok(typeof name === 'string' && name.length > 0);
          assert.equal(typeof contentType, 'string');
          if (['image/svg+xml', 'text/html', 'application/javascript'].includes(contentType)) {
            res.writeHead(415).end(); return true;
          }
          const privatePath = `c/${channelId}/bridge/${randomUUID()}`;
          const part = { type: 'file', url: `https://storage.example/storage/v1/object/sign/message_media/${privatePath}?token=smoke-private`, path: privatePath,
            fileType: contentType.startsWith('image/') ? 'image' : 'file', fileName: name,
            fileSize: bytes.length, mimeType: contentType };
          uploads.set(part.path, { bytes: Buffer.from(bytes), name, contentType });
          writes.push(part);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(part));
          afterWrite?.();
          return true;
        }
        res.writeHead(405).end();
      } catch {
        // Do not let assertions in an HTTP callback dump credential-bearing request state.
        errors.push('Invalid raw media request');
        if (!res.headersSent) res.writeHead(400);
        res.end();
      }
      return true;
    },
  };
}

export async function runMediaSmoke(context) {
  const { matrix, harmony, config, gateway, events, json, until, homeserverUrl, roomPath, roomId,
    user, png, harmonyPosts, harmonyMessages, nativeMessage, channelId, getRelay, getStore,
    restart, setConsent, setNativeEncryption, setStage, signal } = context;
  for (const method of ['downloadFile', 'uploadFile', 'sendFile']) assert.equal(typeof matrix[method], 'function');
  for (const method of ['downloadFile', 'uploadFile']) assert.equal(typeof harmony[method], 'function');
  const nativeFile = { bytes: Buffer.from('Native file bytes: \u0000\u0001\u00ff\n'), name: 'native report café.txt', contentType: 'text/plain' };
  const imageFile = { bytes: png, name: 'tiny image.png', contentType: 'image/png' };
  const sentFiles = [];
  const sentTexts = [];
  const outboundOrder = [];
  let matrixDownloads = 0;
  let matrixUploads = 0;
  let afterMatrixDownload;
  let afterMatrixUpload;
  const originals = Object.fromEntries(['downloadFile', 'uploadFile', 'sendFile', 'sendMessage'].map(key => [key, matrix[key].bind(matrix)]));
  matrix.downloadFile = async (...args) => {
    matrixDownloads++;
    const result = await originals.downloadFile(...args);
    afterMatrixDownload?.();
    return result;
  };
  matrix.uploadFile = async (...args) => {
    matrixUploads++;
    const result = await originals.uploadFile(...args);
    afterMatrixUpload?.();
    return result;
  };
  matrix.sendFile = async (...args) => {
    const result = await originals.sendFile(...args);
    sentFiles.push({ args, result });
    outboundOrder.push('file');
    return result;
  };
  matrix.sendMessage = async (...args) => {
    const result = await originals.sendMessage(...args);
    sentTexts.push({ args, result });
    outboundOrder.push('text');
    return result;
  };
  const snapshot = () => ({ reads: gateway.reads.length, writes: gateway.writes.length,
    downloads: matrixDownloads, uploads: matrixUploads, sends: sentFiles.length });
  async function uploadHuman(file) {
    const response = await fetch(`${homeserverUrl}/_matrix/media/v3/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${user.access_token}`, 'Content-Type': file.contentType },
      body: file.bytes, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    assert.equal(response.ok, true);
    const result = await response.json();
    assert.ok(result.content_uri.startsWith('mxc://'));
    return result.content_uri;
  }
  async function incoming(content) {
    const result = await json(`${roomPath}/send/m.room.message/${randomUUID()}`, {
      method: 'PUT', token: user.access_token, body: { ...content, 'm.mentions': {} },
    });
    await until(() => events.has(result.event_id));
    return events.get(result.event_id);
  }
  async function deliverIncoming(event) {
    const before = harmonyPosts.length;
    getRelay().acceptTransaction(randomUUID(), [event]);
    await getRelay().tick();
    setStage('one final native media POST per Matrix event');
    assert.equal(harmonyPosts.length, before + 1, 'one final native POST per Matrix event');
    return harmonyPosts.at(-1);
  }
  function native(parts, files, id = randomUUID()) {
    const message = { ...nativeMessage(id), content: '', content_raw: parts };
    harmonyMessages.set(id, { ...message });
    for (const [rawIndex, file] of files) gateway.source(id, rawIndex, file);
    assert.equal(getRelay().acceptHarmonyMessage(message), true);
    return message;
  }
  function filePart(file) {
    // An external URL is deliberately poisonous: only the authorized raw-index endpoint may be read.
    return { type: 'file', url: 'https://never-fetch.invalid/not-an-authorized-download',
      path: `c/${channelId}/native/${randomUUID()}`, fileType: file.contentType.startsWith('image/') ? 'image' : 'file',
      fileName: file.name, fileSize: file.bytes.length, mimeType: file.contentType };
  }
  async function checkFile(record, file) {
    const event = await json(`${roomPath}/event/${encodeURIComponent(record.result.event_id)}`, { token: user.access_token });
    assert.equal(event.sender, context.botUserId);
    assert.equal(event.content.msgtype, file.contentType.startsWith('image/') ? 'm.image' : 'm.file');
    assert.ok(event.content.url.startsWith('mxc://'));
    assert.deepEqual(event.content['m.mentions'], {});
    assert.equal(event.content.info.size, file.bytes.length);
    const downloaded = await originals.downloadFile(event.content.url, file.name);
    assert.deepEqual(Buffer.from(downloaded.bytes), file.bytes);
    assert.equal(downloaded.contentType, file.contentType);
    return event;
  }
  function checkCanonical(post, file) {
    setStage('native canonical media part count');
    const parts = post.content.filter(part => part.type === 'file');
    assert.equal(parts.length, 1);
    const part = parts[0];
    setStage('native canonical private media path');
    assert.ok(part.path.startsWith(`c/${channelId}/`));
    setStage('native canonical media filename');
    assert.equal(part.fileName, file.name);
    setStage('native canonical media byte length');
    assert.equal(part.fileSize, file.bytes.length);
    setStage('native canonical media identical bytes');
    assert.deepEqual(gateway.uploads.get(part.path).bytes, file.bytes);
    setStage('native canonical media has no MXC attachment');
    assert.ok(!JSON.stringify(post).includes('mxc://'), 'no MXC URI stored as a native attachment');
  }
  function checkFallback(post) {
    assert.ok(post.content.some(part => part.type === 'text' && part.text.trim()), 'media failure remains visible');
    assert.equal(post.content.filter(part => part.type === 'file').length, 0);
    assert.ok(!JSON.stringify(post.content).includes('https://never-fetch.invalid'));
  }

  try {
    setStage('real Matrix image/file/caption to private native file parts');
    const imageMxc = await uploadHuman(imageFile);
    const documentMxc = await uploadHuman(nativeFile);
    const imageEvent = await incoming({ msgtype: 'm.image', body: imageFile.name, url: imageMxc,
      info: { mimetype: imageFile.contentType, size: png.length } });
    checkCanonical(await deliverIncoming(imageEvent), imageFile);
    const documentEvent = await incoming({ msgtype: 'm.file', body: nativeFile.name, url: documentMxc,
      info: { mimetype: nativeFile.contentType, size: nativeFile.bytes.length } });
    checkCanonical(await deliverIncoming(documentEvent), nativeFile);
    const caption = 'A caption separate from its filename';
    const captionEvent = await incoming({ msgtype: 'm.image', body: caption, filename: imageFile.name, url: imageMxc,
      info: { mimetype: imageFile.contentType, size: png.length } });
    const captionPost = await deliverIncoming(captionEvent);
    checkCanonical(captionPost, imageFile);
    assert.ok(captionPost.content.some(part => part.type === 'text' && part.text.includes(caption)));
    console.log('PASS actual Matrix image, file and caption events become one native POST each with byte-identical private canonical file parts');

    setStage('native file-only, caption and multiple raw-index files to real Matrix media');
    let start = sentFiles.length;
    const fileOnlyTextCount = sentTexts.length;
    native([filePart(nativeFile)], [[0, nativeFile]]);
    await getRelay().tick();
    // Relay mode may prepend native-author attribution even without a caption.
    assert.ok(sentTexts.length === fileOnlyTextCount || sentTexts.length === fileOnlyTextCount + 1);
    if (sentTexts.length > fileOnlyTextCount) assert.equal(sentTexts.at(-1).args[2].trim(), '[Harmony Human · Harmony]');
    assert.equal(sentFiles.length, start + 1);
    await checkFile(sentFiles.at(-1), nativeFile);
    start = sentFiles.length;
    const textStart = sentTexts.length;
    const orderStart = outboundOrder.length;
    native([{ type: 'text', text: 'Native image caption' }, filePart(imageFile)], [[1, imageFile]]);
    await getRelay().tick();
    assert.equal(sentTexts.length, textStart + 1);
    assert.equal(sentFiles.length, start + 1);
    assert.deepEqual(outboundOrder.slice(orderStart), ['text', 'file']);
    assert.ok(sentTexts.at(-1).args[2].includes('Native image caption'));
    await checkFile(sentFiles.at(-1), imageFile);
    start = sentFiles.length;
    const multi = native([{ type: 'text', text: 'Two files in original order' }, filePart(nativeFile),
      { type: 'text', text: 'Between the attachments' }, filePart(imageFile)], [[1, nativeFile], [3, imageFile]]);
    await getRelay().tick();
    assert.equal(sentFiles.length, start + 2);
    assert.deepEqual(gateway.reads.filter(read => read.messageId === multi.id).map(read => read.index), [1, 3]);
    await checkFile(sentFiles[start], nativeFile);
    await checkFile(sentFiles[start + 1], imageFile);
    const secondFileEventId = sentFiles[start + 1].result.event_id;
    console.log('PASS file-only, image+caption and multiple native files produce real MXC events with original raw indices and identical downloaded bytes');

    setStage('visible media fallbacks for encrypted descriptors, unsupported references and oversized metadata');
    for (const content of [
      { msgtype: 'm.file', body: 'Encrypted descriptor is unsupported', file: { url: documentMxc, key: {}, iv: 'unused', hashes: {}, v: 'v2' } },
      { msgtype: 'm.file', body: 'Unsupported external media', url: 'https://never-fetch.invalid/private' },
      { msgtype: 'm.file', body: 'too-large.bin', url: documentMxc, info: { size: MEDIA_LIMIT + 1, mimetype: 'application/octet-stream' } },
      { msgtype: 'm.file', body: 'missing.bin', url: `mxc://localhost/${randomUUID().replaceAll('-', '')}` },
    ]) {
      const before = snapshot();
      checkFallback(await deliverIncoming(await incoming(content)));
      assert.equal(gateway.writes.length, before.writes);
    }
    // The homeserver accepts this fixture, but the bridge must reject actual bytes even
    // when Matrix's untrusted info.size claims a one-byte file.
    setStage('actual over-50-MiB MXC and native raw media download bounds');
    const oversizedFile = { bytes: Buffer.alloc(MEDIA_LIMIT + 1, 0x61), name: 'actual-too-large.bin', contentType: 'application/octet-stream' };
    const oversizedMxc = await uploadHuman(oversizedFile);
    const beforeOversized = snapshot();
    checkFallback(await deliverIncoming(await incoming({ msgtype: 'm.file', body: oversizedFile.name,
      url: oversizedMxc, info: { size: 1, mimetype: oversizedFile.contentType } })));
    assert.equal(gateway.writes.length, beforeOversized.writes);
    const oversizedPart = { ...filePart(oversizedFile), fileSize: 1 };
    const textsBeforeOversized = sentTexts.length;
    native([oversizedPart], [[0, oversizedFile]]);
    await getRelay().tick();
    assert.equal(matrixUploads, beforeOversized.uploads);
    assert.ok(sentTexts.length > textsBeforeOversized);
    assert.ok(sentTexts.at(-1).args[2].includes('Attachment unavailable'));
    assert.equal(sentFiles.length, beforeOversized.sends);
    const svg = { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), name: 'unsupported.svg', contentType: 'image/svg+xml' };
    const svgMxc = await uploadHuman(svg);
    const beforeUnsupported = gateway.writes.length;
    checkFallback(await deliverIncoming(await incoming({ msgtype: 'm.file', body: svg.name, url: svgMxc })));
    assert.equal(gateway.writes.length, beforeUnsupported);
    gateway.failWrites(true);
    try { checkFallback(await deliverIncoming(await incoming({ msgtype: 'm.file', body: nativeFile.name, url: documentMxc }))); }
    finally { gateway.failWrites(false); }
    gateway.failReads(true);
    start = sentTexts.length;
    native([filePart(nativeFile)], [[0, nativeFile]]);
    await getRelay().tick();
    gateway.failReads(false);
    assert.ok(sentTexts.length > start);
    assert.ok(sentTexts.at(-1).args[2].includes('Attachment unavailable'));
    console.log('PASS unsupported/encrypted/oversized media and failed raw media transfers produce safe visible fallbacks');

    setStage('queued media consent and plaintext checks precede upload');
    let before = snapshot();
    native([filePart(nativeFile)], [[0, nativeFile]]);
    setConsent(false);
    await getRelay().tick();
    setConsent(true);
    assert.deepEqual(snapshot(), before, 'opt-out before delivery prevents download/upload/file send');
    before = snapshot();
    native([filePart(nativeFile)], [[0, nativeFile]]);
    setNativeEncryption(true);
    await getRelay().tick();
    setNativeEncryption(false);
    assert.deepEqual(snapshot(), before, 'encrypted native channel prevents media transfer');
    before = snapshot();
    afterMatrixDownload = () => setNativeEncryption(true);
    const blocked = await incoming({ msgtype: 'm.file', body: nativeFile.name, url: documentMxc });
    getRelay().acceptTransaction(randomUUID(), [blocked]);
    await getRelay().tick();
    afterMatrixDownload = undefined;
    setNativeEncryption(false);
    assert.equal(gateway.writes.length, before.writes, 'crypto change after Matrix download prevents native upload');
    before = snapshot();
    gateway.afterRead(() => setConsent(false));
    native([filePart(nativeFile)], [[0, nativeFile]]);
    await getRelay().tick();
    gateway.afterRead(undefined);
    setConsent(true);
    assert.equal(matrixUploads, before.uploads, 'opt-out after native download prevents Matrix upload');
    before = snapshot();
    afterMatrixUpload = () => setConsent(false);
    native([filePart(nativeFile)], [[0, nativeFile]]);
    await getRelay().tick();
    afterMatrixUpload = undefined;
    setConsent(true);
    assert.equal(sentFiles.length, before.sends, 'opt-out after upload prevents Matrix event send');
    before = snapshot();
    afterMatrixUpload = () => setNativeEncryption(true);
    native([filePart(nativeFile)], [[0, nativeFile]]);
    await getRelay().tick();
    afterMatrixUpload = undefined;
    setNativeEncryption(false);
    assert.equal(sentFiles.length, before.sends, 'crypto change after upload prevents Matrix event send');
    const postsBeforeFence = harmonyPosts.length;
    gateway.afterWrite(() => setNativeEncryption(true));
    const encryptedAfterUpload = await incoming({ msgtype: 'm.file', body: nativeFile.name, url: documentMxc });
    getRelay().acceptTransaction(randomUUID(), [encryptedAfterUpload]);
    await getRelay().tick();
    gateway.afterWrite(undefined);
    setNativeEncryption(false);
    assert.equal(harmonyPosts.length, postsBeforeFence, 'crypto change after native upload prevents final native POST');
    console.log('PASS queued file opt-out/crypto fences, consent before upload/after upload, and crypto rechecks before both destination sends');

    setStage('restart with uncertain file send and stable per-file transactions');
    let loseResponse = true;
    let firstEvent;
    const attempts = [];
    matrix.sendFile = async (...args) => {
      const result = await originals.sendFile(...args);
      attempts.push({ txn: args[1], sender: args[3]?.sender, eventId: result.event_id });
      if (loseResponse) {
        loseResponse = false;
        firstEvent = result.event_id;
        const { HttpError } = await import('../dist/http.js');
        throw new HttpError('Simulated lost file response', true, 503);
      }
      return result;
    };
    const retried = native([filePart(nativeFile)], [[0, nativeFile]]);
    await getRelay().tick();
    assert.equal(attempts.length, 1);
    await restart();
    await until(() => getStore().nextJob() !== null);
    await getRelay().tick();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].txn, attempts[1].txn);
    assert.equal(attempts[0].sender, attempts[1].sender);
    assert.equal(attempts[1].eventId, firstEvent);
    const persisted = await json(`${roomPath}/event/${encodeURIComponent(firstEvent)}`, { token: user.access_token });
    assert.equal(persisted.sender, context.botUserId);
    const beforeDuplicate = attempts.length;
    getRelay().acceptHarmonyMessage(harmonyMessages.get(retried.id));
    await getRelay().tick();
    assert.equal(attempts.length, beforeDuplicate);
    const postsBeforeDuplicate = harmonyPosts.length;
    getRelay().acceptTransaction(randomUUID(), [imageEvent]);
    await getRelay().tick();
    assert.equal(harmonyPosts.length, postsBeforeDuplicate);
    setStage('real Matrix reply to a non-first outbound file after restart');
    assert.equal(getStore().findSource('to_matrix', secondFileEventId, channelId, roomId), multi.id);
    const laterFileReply = await deliverIncoming(await incoming({ msgtype: 'm.text',
      body: 'Reply to the second attachment after restart',
      'm.relates_to': { 'm.in_reply_to': { event_id: secondFileEventId } } }));
    assert.equal(laterFileReply.reply_to, multi.id);
    assert.deepEqual(laterFileReply.content, [{ type: 'text', text: 'Reply to the second attachment after restart' }]);
    console.log('PASS real Matrix reply to the second outbound attachment maps to the native original after persisted-store restart');
    assert.deepEqual(gateway.errors, []);
    console.log('PASS persisted media job restart, stable file transaction idempotency, same sender, and duplicate input suppression in both directions');
    return {
      fenceEvent: await incoming({ msgtype: 'm.file', body: imageFile.name, url: imageMxc }),
      enqueueNativeFence: () => native([filePart(nativeFile)], [[0, nativeFile]]),
    };
  } finally {
    setConsent(true);
    setNativeEncryption(false);
    gateway.failReads(false);
    gateway.failWrites(false);
    gateway.afterRead(undefined);
    gateway.afterWrite(undefined);
    Object.assign(matrix, originals);
  }
}
