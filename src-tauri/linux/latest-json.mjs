// Adds the Linux AppImage to a tauri-plugin-updater latest.json, keeping every
// platform entry already present (tauri-action writes the Windows and macOS ones).
//
// Usage: node latest-json.mjs <latest.json> <version> <appimage-url> <appimage.sig>
// The file is created when absent, with the fields tauri-action writes.
// tauri-plugin-updater looks up `<os>-<arch>-<bundle>` first, then `<os>-<arch>`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [file, version, url, sigFile] = process.argv.slice(2);
if (!file || !version || !url || !sigFile) {
  console.error('usage: latest-json.mjs <latest.json> <version> <appimage-url> <appimage.sig>');
  process.exit(2);
}

const doc = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : {
      version,
      notes: 'Download the installer for your platform below.',
      pub_date: new Date().toISOString(),
      platforms: {},
    };

if (doc.version !== version) {
  console.error(`latest.json is for ${doc.version}, not ${version}`);
  process.exit(1);
}

const entry = { signature: readFileSync(sigFile, 'utf8').trim(), url };
doc.platforms = { ...doc.platforms, 'linux-x86_64': entry, 'linux-x86_64-appimage': entry };
writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`latest.json platforms: ${Object.keys(doc.platforms).join(', ')}`);
