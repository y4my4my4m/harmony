// node --test scripts/github-release.test.mjs
// Runs scripts/github-release.mjs and scripts/name-artifact.sh against an
// in-process stand-in for the GitHub releases REST API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { client, ensureRelease, main, ReleaseError, PLATFORM_KEYS } from './github-release.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const OWNER_REPO = 'acme/harmony';
const TAG = 'v1.6.7';
const VERSION = '1.6.7';
const WINDOWS = `Harmony_Windows_V${VERSION}.exe`;
const MACOS = `Harmony_macOS_V${VERSION}.app.tar.gz`;
const BODY = 'Download the installer for your platform below.';

function fakeSig(file, nonce = 'a') {
  const text =
    'untrusted comment: signature from tauri secret key\n' +
    `RUQ${nonce.repeat(8)}\n` +
    `trusted comment: timestamp:1759400000\tfile:${file}\n` +
    `${nonce.repeat(12)}==\n`;
  return Buffer.from(text).toString('base64');
}

// Release REST API subset: list/create/get releases, list/download/delete
// assets, upload. Two items per page, so pagination is exercised.
async function fakeGitHub() {
  const releases = [];
  let nextId = 100;
  const blobAuth = [];
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, base);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    const page = (items) => {
      const n = Number(url.searchParams.get('page') || 1);
      const slice = items.slice((n - 1) * 2, n * 2);
      const headers = {};
      if (n * 2 < items.length) {
        const next = new URL(url);
        next.searchParams.set('page', String(n + 1));
        headers.link = `<${next}>; rel="next"`;
      }
      send(200, slice, headers);
    };
    const view = (r) => ({
      id: r.id,
      tag_name: r.tag_name,
      name: r.name,
      body: r.body,
      draft: r.draft,
      upload_url: `${base}/uploads/repos/${OWNER_REPO}/releases/${r.id}/assets{?name,label}`,
    });
    const assetView = (r, a) => ({
      id: a.id,
      name: a.name,
      state: a.state,
      size: a.data.length,
      browser_download_url: `${base}/${OWNER_REPO}/releases/download/${r.draft ? `untagged-${r.id}abc` : r.tag_name}/${a.name}`,
    });
    const findAsset = (id) => {
      for (const r of releases) {
        const a = r.assets.find((x) => x.id === id);
        if (a) return [r, a];
      }
      return [];
    };

    const api = `/api/repos/${OWNER_REPO}`;
    let m;
    if (url.pathname.startsWith('/api/') && req.headers.authorization !== 'Bearer t0ken') {
      return send(401, { message: 'Bad credentials' });
    }
    if (url.pathname === `${api}/releases` && req.method === 'GET') return page(releases.map(view));
    if (url.pathname === `${api}/releases` && req.method === 'POST') {
      const j = JSON.parse(body);
      const r = { id: nextId++, tag_name: j.tag_name, name: j.name, body: j.body, draft: j.draft, assets: [], created: j };
      releases.push(r);
      return send(201, view(r));
    }
    if ((m = url.pathname.match(new RegExp(`^${api}/releases/(\\d+)$`)))) {
      const r = releases.find((x) => x.id === Number(m[1]));
      return r ? send(200, view(r)) : send(404, { message: 'Not Found' });
    }
    if ((m = url.pathname.match(new RegExp(`^${api}/releases/(\\d+)/assets$`)))) {
      const r = releases.find((x) => x.id === Number(m[1]));
      return r ? page(r.assets.map((a) => assetView(r, a))) : send(404, { message: 'Not Found' });
    }
    if ((m = url.pathname.match(new RegExp(`^${api}/releases/assets/(\\d+)$`)))) {
      const [r, a] = findAsset(Number(m[1]));
      if (!a) return send(404, { message: 'Not Found' });
      if (req.method === 'DELETE') {
        r.assets.splice(r.assets.indexOf(a), 1);
        return send(204);
      }
      if (req.headers.accept === 'application/octet-stream') {
        return send(302, undefined, { location: `${base}/blob/${a.id}` });
      }
      return send(200, assetView(r, a));
    }
    if ((m = url.pathname.match(/^\/blob\/(\d+)$/))) {
      blobAuth.push(req.headers.authorization ?? null);
      const [, a] = findAsset(Number(m[1]));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(a.data);
    }
    if ((m = url.pathname.match(new RegExp(`^/uploads/repos/${OWNER_REPO}/releases/(\\d+)/assets$`)))) {
      const r = releases.find((x) => x.id === Number(m[1]));
      const name = url.searchParams.get('name');
      if (r.assets.some((a) => a.name === name)) return send(422, { message: 'already_exists' });
      const a = { id: nextId++, name, state: 'uploaded', data: body, contentType: req.headers['content-type'] };
      r.assets.push(a);
      return send(201, assetView(r, a));
    }
    send(404, { message: `unrouted ${req.method} ${url.pathname}` });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gh = client({ token: 't0ken', repository: OWNER_REPO, apiUrl: `${base}/api` });

  // tauri-action uploadAssets: delete a same-named asset, then upload.
  async function upload(releaseId, name, data) {
    const r = releases.find((x) => x.id === releaseId);
    const old = r.assets.find((a) => a.name === name);
    if (old) r.assets.splice(r.assets.indexOf(old), 1);
    r.assets.push({ id: nextId++, name, state: 'uploaded', data: Buffer.from(data) });
  }
  const names = (releaseId) => releases.find((x) => x.id === releaseId).assets.map((a) => a.name).sort();
  const asset = (releaseId, name) => releases.find((x) => x.id === releaseId).assets.find((a) => a.name === name);
  return { server, base, gh, releases, upload, names, asset, blobAuth, close: () => server.close() };
}

async function windowsJob(f, id, nonce = 'w') {
  await f.upload(id, WINDOWS, 'MZ windows installer');
  await f.upload(id, `${WINDOWS}.sig`, fakeSig('Harmony_1.6.7_x64-setup.exe', nonce));
}
async function macosJob(f, id, nonce = 'm') {
  await f.upload(id, `Harmony_macOS_V${VERSION}.dmg`, 'dmg bytes');
  await f.upload(id, MACOS, 'gzip app bundle');
  await f.upload(id, `${MACOS}.sig`, fakeSig('Harmony.app.tar.gz', nonce));
}
const latestArgs = (id) => [
  'latest-json', '--release-id', String(id), '--tag', TAG, '--version', VERSION,
  '--windows', WINDOWS, '--macos', MACOS,
];
const quiet = () => {};

test('Windows and macOS present: one latest.json with tauri-action keys', async (t) => {
  const f = await fakeGitHub();
  t.after(f.close);
  const id = await main(['ensure', '--tag', TAG, '--name', `Harmony ${VERSION}`, '--body', BODY], { gh: f.gh, log: quiet });
  await windowsJob(f, id);
  await macosJob(f, id);

  const manifest = await main(latestArgs(id), { gh: f.gh, log: quiet });
  const uploaded = JSON.parse(f.asset(id, 'latest.json').data);
  assert.deepEqual(uploaded, manifest);
  assert.equal(f.asset(id, 'latest.json').contentType, 'application/json');

  assert.deepEqual(Object.keys(manifest), ['version', 'notes', 'pub_date', 'platforms']);
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.notes, BODY);
  assert.match(manifest.pub_date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [...PLATFORM_KEYS.windows, ...PLATFORM_KEYS.macos].sort());

  const win = { signature: f.asset(id, `${WINDOWS}.sig`).data.toString(), url: `${f.base}/${OWNER_REPO}/releases/download/${TAG}/${WINDOWS}` };
  const mac = { signature: f.asset(id, `${MACOS}.sig`).data.toString(), url: `${f.base}/${OWNER_REPO}/releases/download/${TAG}/${MACOS}` };
  for (const k of PLATFORM_KEYS.windows) assert.deepEqual(manifest.platforms[k], win);
  for (const k of PLATFORM_KEYS.macos) assert.deepEqual(manifest.platforms[k], mac);

  assert.deepEqual(f.blobAuth, [null, null], 'token is not sent to the asset redirect target');
});

for (const [label, drop] of [
  ['macOS signature', `${MACOS}.sig`],
  ['macOS payload', MACOS],
  ['Windows payload', WINDOWS],
]) {
  test(`${label} missing: fails and uploads nothing`, async (t) => {
    const f = await fakeGitHub();
    t.after(f.close);
    const id = await main(['ensure', '--tag', TAG, '--name', `Harmony ${VERSION}`, '--body', BODY], { gh: f.gh, log: quiet });
    await windowsJob(f, id);
    await macosJob(f, id);
    const r = f.releases.find((x) => x.id === id);
    r.assets.splice(r.assets.indexOf(f.asset(id, drop)), 1);
    const before = f.names(id);

    await assert.rejects(main(latestArgs(id), { gh: f.gh, log: quiet }), (err) => {
      assert.ok(err instanceof ReleaseError);
      assert.match(err.message, new RegExp(`lacks updater assets: ${drop.replace(/\./g, '\\.')}$`, 'm'));
      return true;
    });
    assert.deepEqual(f.names(id), before);
    assert.equal(f.asset(id, 'latest.json'), undefined);
  });
}

test('Only one desktop job ran: fails and uploads nothing', async (t) => {
  const f = await fakeGitHub();
  t.after(f.close);
  const id = await main(['ensure', '--tag', TAG, '--name', `Harmony ${VERSION}`, '--body', BODY], { gh: f.gh, log: quiet });
  await windowsJob(f, id);
  await assert.rejects(main(latestArgs(id), { gh: f.gh, log: quiet }), /lacks updater assets: Harmony_macOS_V1\.6\.7\.app\.tar\.gz, Harmony_macOS_V1\.6\.7\.app\.tar\.gz\.sig$/m);
  assert.equal(f.asset(id, 'latest.json'), undefined);
});

test('Malformed signature: fails and uploads nothing', async (t) => {
  const f = await fakeGitHub();
  t.after(f.close);
  const id = await main(['ensure', '--tag', TAG, '--name', `Harmony ${VERSION}`, '--body', BODY], { gh: f.gh, log: quiet });
  await windowsJob(f, id);
  await macosJob(f, id);
  await f.upload(id, `${WINDOWS}.sig`, `${fakeSig('x')}\n`);
  await assert.rejects(main(latestArgs(id), { gh: f.gh, log: quiet }), /Harmony_Windows_V1\.6\.7\.exe\.sig is not standard base64/);
  await f.upload(id, `${WINDOWS}.sig`, Buffer.from('not a signature').toString('base64'));
  await assert.rejects(main(latestArgs(id), { gh: f.gh, log: quiet }), /does not decode to a minisign signature/);
  assert.equal(f.asset(id, 'latest.json'), undefined);
});

test('Re-run: ensure reuses the release and drops latest.json; rebuild replaces it once', async (t) => {
  const f = await fakeGitHub();
  t.after(f.close);
  const ensure = () => main(['ensure', '--tag', TAG, '--name', `Harmony ${VERSION}`, '--body', BODY], { gh: f.gh, log: quiet });
  // Unrelated releases ahead of ours, so the tag scan spans pages.
  for (const tag of ['v1.6.4', 'v1.6.5', 'v1.6.6']) await ensureRelease(f.gh, { tag, name: tag, body: '' });

  const id = await ensure();
  await windowsJob(f, id, 'w');
  await macosJob(f, id, 'm');
  const first = await main(latestArgs(id), { gh: f.gh, log: quiet });

  assert.equal(await ensure(), id);
  assert.equal(f.releases.filter((r) => r.tag_name === TAG).length, 1);
  assert.equal(f.asset(id, 'latest.json'), undefined, 'a new run starts without a manifest');

  await windowsJob(f, id, 'x');
  await macosJob(f, id, 'y');
  const second = await main(latestArgs(id), { gh: f.gh, log: quiet });
  const third = await main(latestArgs(id), { gh: f.gh, log: quiet });

  assert.equal(f.names(id).filter((n) => n === 'latest.json').length, 1);
  assert.notEqual(second.platforms['windows-x86_64'].signature, first.platforms['windows-x86_64'].signature);
  assert.equal(second.platforms['darwin-aarch64'].signature, f.asset(id, `${MACOS}.sig`).data.toString());
  assert.deepEqual({ ...third, pub_date: '' }, { ...second, pub_date: '' });
  assert.deepEqual(JSON.parse(f.asset(id, 'latest.json').data), third);
});

test('Release id of another tag is refused', async (t) => {
  const f = await fakeGitHub();
  t.after(f.close);
  const other = await ensureRelease(f.gh, { tag: 'v1.6.6', name: 'x', body: '' });
  await assert.rejects(main(latestArgs(other.id), { gh: f.gh, log: quiet }), /is tagged v1\.6\.6, expected v1\.6\.7/);
});

test('ensure creates a draft, non-prerelease release at the commitish', async (t) => {
  const f = await fakeGitHub();
  t.after(f.close);
  const { id, created } = await ensureRelease(f.gh, { tag: TAG, name: `Harmony ${VERSION}`, body: BODY, commitish: 'abc123' });
  assert.equal(created, true);
  assert.deepEqual(f.releases.find((r) => r.id === id).created, {
    tag_name: TAG, name: `Harmony ${VERSION}`, body: BODY, draft: true, prerelease: false, target_commitish: 'abc123',
  });
});

test('CLI: writes GITHUB_OUTPUT, --out matches the upload, exits 1 on a missing platform', async (t) => {
  const f = await fakeGitHub();
  t.after(f.close);
  const dir = mkdtempSync(join(tmpdir(), 'gh-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GITHUB_TOKEN: 't0ken',
    GITHUB_REPOSITORY: OWNER_REPO,
    GITHUB_API_URL: `${f.base}/api`,
    GITHUB_SHA: 'abc123',
    GITHUB_OUTPUT: join(dir, 'out'),
  };
  const script = join(here, 'github-release.mjs');
  await run('node', [script, 'ensure', '--tag', TAG, '--name', `Harmony ${VERSION}`, '--body', BODY], { env });
  const id = Number(/^id=(\d+)$/m.exec(readFileSync(env.GITHUB_OUTPUT, 'utf8'))[1]);

  await windowsJob(f, id);
  const fail = await run('node', [script, ...latestArgs(id)], { env }).then(() => null, (e) => e);
  assert.equal(fail?.code, 1);
  assert.match(fail.stderr, /^::error::release v1\.6\.7 lacks updater assets/);

  await macosJob(f, id);
  const out = join(dir, 'latest.json');
  await run('node', [script, ...latestArgs(id), '--out', out], { env });
  assert.equal(readFileSync(out, 'utf8'), f.asset(id, 'latest.json').data.toString());
});

async function nameArtifact(cwd, args, env = {}) {
  const { stdout } = await run('bash', [join(here, 'name-artifact.sh'), ...args], {
    cwd,
    env: { ...process.env, GITHUB_REF_NAME: '', GITHUB_SHA: '', GITHUB_OUTPUT: '', ...env },
  });
  return stdout.trim();
}

test('name-artifact.sh: release and dev names', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'name-artifact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src-tauri'));
  writeFileSync(join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: VERSION }));
  const dev = { GITHUB_REF_NAME: 'feat/push_v2', GITHUB_SHA: '1a2b3c4d5e6f' };

  assert.equal(await nameArtifact(dir, ['--release', 'Windows', 'release']), `Harmony_Windows_V${VERSION}`);
  assert.equal(await nameArtifact(dir, ['--release', 'macOS', 'release']), `Harmony_macOS_V${VERSION}`);
  assert.equal(await nameArtifact(dir, ['--release', 'Android', 'debug']), `Harmony_Android_V${VERSION}_debug`);
  assert.equal(await nameArtifact(dir, ['Windows', 'release'], dev), `Harmony_Windows_V${VERSION}_dev-feat-push-v2-1a2b3c4`);
  assert.equal(await nameArtifact(dir, ['Android', 'debug'], dev), `Harmony_Android_V${VERSION}_debug-feat-push-v2-1a2b3c4`);
  await assert.rejects(nameArtifact(dir, ['Windows', 'release']), /GITHUB_REF_NAME and GITHUB_SHA must be set/);
  await assert.rejects(nameArtifact(dir, ['Linux', 'release']), /usage/);

  mkdirSync(join(dir, 'apk'));
  writeFileSync(join(dir, 'apk/app-universal-release.apk'), 'apk');
  const outFile = join(dir, 'gh-out');
  const moved = await nameArtifact(dir, ['--release', 'Android', 'release', 'apk/app-universal-release.apk'], { GITHUB_OUTPUT: outFile });
  assert.equal(moved, `apk/Harmony_Android_V${VERSION}.apk`);
  assert.ok(existsSync(join(dir, moved)));
  assert.equal(readFileSync(outFile, 'utf8'), `path=${moved}\n`);
});
