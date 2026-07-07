#!/usr/bin/env node
// Stamp a version across every file that carries it, so releases stay in sync
// with the git tag. Usage: node scripts/set-version.mjs <x.y.z | vx.y.z>
import { readFileSync, writeFileSync } from 'node:fs';

const raw = process.argv[2] || '';
const version = raw.replace(/^v/, '').trim();
const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) {
  console.error(`Invalid version "${raw}". Expected x.y.z (optionally v-prefixed).`);
  process.exit(1);
}
const [, maj, min, pat] = m.map(Number);
const versionCode = maj * 1_000_000 + min * 1_000 + pat; // monotonic, matches existing scheme

function editJson(path, mutate) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  mutate(json);
  writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`✓ ${path}`);
}

// package.json
editJson('package.json', (j) => { j.version = version; });

// tauri.conf.json
editJson('src-tauri/tauri.conf.json', (j) => { j.version = version; });

// Cargo.toml — only the [package] version line
{
  const path = 'src-tauri/Cargo.toml';
  const lines = readFileSync(path, 'utf8').split('\n');
  const pkgIdx = lines.findIndex((l) => l.trim() === '[package]');
  const verIdx = lines.findIndex((l, i) => i > pkgIdx && /^version\s*=/.test(l));
  if (pkgIdx === -1 || verIdx === -1) { console.error('Cargo.toml [package] version not found'); process.exit(1); }
  lines[verIdx] = `version = "${version}"`;
  writeFileSync(path, lines.join('\n'));
  console.log(`✓ ${path}`);
}

// Android tauri.properties
{
  const path = 'src-tauri/gen/android/app/tauri.properties';
  const out = readFileSync(path, 'utf8')
    .replace(/tauri\.android\.versionName=.*/, `tauri.android.versionName=${version}`)
    .replace(/tauri\.android\.versionCode=.*/, `tauri.android.versionCode=${versionCode}`);
  writeFileSync(path, out);
  console.log(`✓ ${path} (versionCode ${versionCode})`);
}

console.log(`\nVersion set to ${version} (versionCode ${versionCode}).`);
