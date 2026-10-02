#!/usr/bin/env node
// GitHub release steps of .github/workflows/release.yml.
//
//   node scripts/github-release.mjs ensure --tag <tag> --name <name> --body <body>
//     Finds the release for <tag>, drafts one when absent, and deletes its
//     latest.json: the manifest exists only once every build of the run has
//     uploaded. Prints the id and appends `id=<id>` to GITHUB_OUTPUT when that
//     is set.
//
//   node scripts/github-release.mjs latest-json --release-id <id> --tag <tag>
//       --version <x.y.z> --windows <asset> --macos <asset> [--out <file>]
//     Writes the updater manifest from the release's uploaded assets and
//     replaces the release's latest.json with it. <asset> is the updater
//     payload; its signature is the asset named <asset>.sig. Exits non-zero,
//     uploading nothing, when a payload or signature is absent or malformed.
//
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), GITHUB_API_URL
// (default https://api.github.com), GITHUB_SHA (commitish of a new release).
//
// Mirrors tauri-action v0.6.2 (84b9d35) getOrCreateRelease and
// uploadVersionJSON with includeUpdaterJson, updaterJsonPreferNsis, unzipped
// signatures (bundle.createUpdaterArtifacts: true) and
// updaterJsonKeepUniversal false. Deviations: one writer instead of a
// read-merge-write per build job, so concurrent jobs cannot drop each other's
// platforms; entries are rebuilt from scratch, where tauri-action keeps stale
// darwin-* entries of an earlier run; a missing platform is an error, where
// tauri-action uploads what it has.
import { writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const MANIFEST = 'latest.json';

// Keys tauri-action v0.6.2 writes, per build in release.yml.
// x86_64-pc-windows-msvc NSIS, unzipped .exe.sig: `${os}-${arch}` and
// `${os}-${arch}-${bundle}` with os windows, arch x64 -> x86_64, bundle nsis.
// universal-apple-darwin .app.tar.gz.sig: the universal build fills both
// darwin arches, bundle app; no darwin-universal key.
// tauri-plugin-updater 2.9.0 reads `${os}-${arch}` only.
export const PLATFORM_KEYS = {
  windows: ['windows-x86_64', 'windows-x86_64-nsis'],
  macos: ['darwin-aarch64', 'darwin-x86_64', 'darwin-aarch64-app', 'darwin-x86_64-app'],
};

export class ReleaseError extends Error {}

export function client({
  token = process.env.GITHUB_TOKEN,
  repository = process.env.GITHUB_REPOSITORY,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
} = {}) {
  if (!token) throw new ReleaseError('GITHUB_TOKEN is not set');
  if (!/^[^/]+\/[^/]+$/.test(repository || '')) {
    throw new ReleaseError(`GITHUB_REPOSITORY is not owner/repo: ${repository}`);
  }
  const base = apiUrl.replace(/\/$/, '');
  const repoUrl = `${base}/repos/${repository}`;
  const headers = {
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'harmony-release',
  };

  async function request(method, url, { body, accept = 'application/vnd.github+json', contentType, redirect } = {}) {
    const res = await fetch(url.startsWith('http') ? url : `${repoUrl}${url}`, {
      method,
      headers: { ...headers, accept, ...(contentType ? { 'content-type': contentType } : {}) },
      body,
      redirect,
    });
    return res;
  }

  async function json(method, url, opts = {}) {
    const res = await request(method, url, opts);
    if (!res.ok) {
      throw new ReleaseError(`${method} ${url}: ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // Follows Link rel="next"; GitHub caps per_page at 100.
  async function paginate(url) {
    const out = [];
    let next = `${repoUrl}${url}${url.includes('?') ? '&' : '?'}per_page=100`;
    while (next) {
      const res = await request('GET', next);
      if (!res.ok) throw new ReleaseError(`GET ${next}: ${res.status} ${await res.text()}`);
      out.push(...(await res.json()));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '')?.[1];
    }
    return out;
  }

  // The asset endpoint answers octet-stream requests with a redirect to a
  // pre-signed URL; the token is not forwarded there.
  async function download(assetId) {
    const url = `/releases/assets/${assetId}`;
    let res = await request('GET', url, { accept: 'application/octet-stream', redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new ReleaseError(`GET ${url}: ${res.status} without Location`);
      res = await fetch(location);
    }
    if (!res.ok) throw new ReleaseError(`GET ${url}: ${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  return { request, json, paginate, download };
}

export async function ensureRelease(gh, { tag, name, body, commitish }) {
  // Drafts are not addressable by tag; tauri-action scans the list too.
  const existing = (await gh.paginate('/releases')).find((r) => r.tag_name === tag);
  if (existing) {
    const dropped = await deleteManifest(gh, existing.id);
    return { id: existing.id, created: false, dropped };
  }
  const created = await gh.json('POST', '/releases', {
    contentType: 'application/json',
    body: JSON.stringify({
      tag_name: tag,
      name,
      body,
      draft: true,
      prerelease: false,
      ...(commitish ? { target_commitish: commitish } : {}),
    }),
  });
  return { id: created.id, created: true, dropped: 0 };
}

async function deleteManifest(gh, releaseId) {
  const stale = (await gh.paginate(`/releases/${releaseId}/assets`)).filter((a) => a.name === MANIFEST);
  for (const a of stale) await gh.json('DELETE', `/releases/assets/${a.id}`);
  return stale.length;
}

// Signature asset contents as tauri-plugin-updater verify_signature decodes
// them: standard base64 of a minisign signature file.
export function checkSignature(name, text) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new ReleaseError(`${name} is not standard base64`);
  }
  const decoded = Buffer.from(text, 'base64').toString('utf8');
  if (!decoded.startsWith('untrusted comment:') || !decoded.includes('\ntrusted comment:')) {
    throw new ReleaseError(`${name} does not decode to a minisign signature`);
  }
}

// Draft asset URLs carry an `untagged-<hash>` segment that stops resolving once
// the draft is published; tauri-action substitutes the tag.
export function publicUrl(browserDownloadUrl, tag) {
  return browserDownloadUrl.replace(
    /\/download\/(untagged-[^/]+)\//,
    `/download/${encodeURIComponent(tag)}/`,
  );
}

export async function buildManifest(gh, { releaseId, tag, version, payloads, now = new Date() }) {
  const release = await gh.json('GET', `/releases/${releaseId}`);
  if (release.tag_name !== tag) {
    throw new ReleaseError(`release ${releaseId} is tagged ${release.tag_name}, expected ${tag}`);
  }
  const assets = await gh.paginate(`/releases/${releaseId}/assets`);
  const byName = new Map(assets.map((a) => [a.name, a]));

  const missing = [];
  for (const name of Object.values(payloads)) {
    for (const n of [name, `${name}.sig`]) {
      const a = byName.get(n);
      if (!a || a.state !== 'uploaded' || !(a.size > 0)) missing.push(n);
    }
  }
  if (missing.length) {
    throw new ReleaseError(
      `release ${tag} lacks updater assets: ${missing.join(', ')}\n` +
        `present: ${assets.map((a) => a.name).join(', ') || '(none)'}`,
    );
  }

  const platforms = {};
  for (const [platform, name] of Object.entries(payloads)) {
    const keys = PLATFORM_KEYS[platform];
    if (!keys) throw new ReleaseError(`unknown platform ${platform}`);
    const sigName = `${name}.sig`;
    const signature = (await gh.download(byName.get(sigName).id)).toString('utf8');
    checkSignature(sigName, signature);
    const url = publicUrl(byName.get(name).browser_download_url, tag);
    for (const key of keys) platforms[key] = { signature, url };
  }

  return {
    version,
    notes: release.body ?? '',
    pub_date: now.toISOString(),
    platforms,
  };
}

export async function uploadManifest(gh, { releaseId, manifest }) {
  const release = await gh.json('GET', `/releases/${releaseId}`);
  await deleteManifest(gh, releaseId);
  // upload_url is an RFC 6570 template: .../assets{?name,label}
  const uploadUrl = `${release.upload_url.replace(/\{.*\}$/, '')}?name=${MANIFEST}`;
  const body = Buffer.from(JSON.stringify(manifest, null, 2));
  const uploaded = await gh.json('POST', uploadUrl, { body, contentType: 'application/json' });
  return uploaded;
}

function required(values, keys) {
  for (const k of keys) {
    if (!values[k]) throw new ReleaseError(`--${k} is required`);
  }
}

export async function main(argv, { gh: ghOverride, log = console.log } = {}) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      tag: { type: 'string' },
      name: { type: 'string' },
      body: { type: 'string' },
      'release-id': { type: 'string' },
      version: { type: 'string' },
      windows: { type: 'string' },
      macos: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const gh = ghOverride ?? client();

  if (command === 'ensure') {
    required(values, ['tag', 'name']);
    const { id, created, dropped } = await ensureRelease(gh, {
      tag: values.tag,
      name: values.name,
      body: values.body ?? '',
      commitish: process.env.GITHUB_SHA,
    });
    log(`${created ? 'Created draft' : 'Found'} release ${id} for ${values.tag}`);
    if (dropped) log(`Deleted ${MANIFEST} from release ${id}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `id=${id}\n`);
    return id;
  }

  if (command === 'latest-json') {
    required(values, ['release-id', 'tag', 'version', 'windows', 'macos']);
    if (!/^\d+\.\d+\.\d+$/.test(values.version)) {
      throw new ReleaseError(`--version is not x.y.z: ${values.version}`);
    }
    const releaseId = values['release-id'];
    const manifest = await buildManifest(gh, {
      releaseId,
      tag: values.tag,
      version: values.version,
      payloads: { windows: values.windows, macos: values.macos },
    });
    const text = JSON.stringify(manifest, null, 2);
    if (values.out) writeFileSync(values.out, text);
    log(text);
    await uploadManifest(gh, { releaseId, manifest });
    log(`Uploaded ${MANIFEST} to release ${releaseId}`);
    return manifest;
  }

  throw new ReleaseError(`usage: github-release.mjs <ensure|latest-json> [options]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
