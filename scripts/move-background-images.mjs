#!/usr/bin/env node
/**
 * Copies background images into per-purpose folders, renaming to a bare index:
 * - /public/img/login_bg<n>.*   -> /public/backgrounds/login/<n>.*
 * - /public/img/offline_bg<n>.* -> /public/backgrounds/offline/<n>.*
 * - /public/404[_<n>].*         -> /public/backgrounds/404/<n>.*
 *
 * Sources are copied, not deleted.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMG_DIR = path.join(__dirname, '../public/img');
const BACKGROUNDS_DIR = path.join(__dirname, '../public/backgrounds');
const LOGIN_DIR = path.join(BACKGROUNDS_DIR, 'login');
const OFFLINE_DIR = path.join(BACKGROUNDS_DIR, 'offline');

function moveBackgroundImages() {
  console.log('Moving background images to organized folders...\n');
  
  if (!fs.existsSync(LOGIN_DIR)) {
    fs.mkdirSync(LOGIN_DIR, { recursive: true });
    console.log('Created /public/backgrounds/login/');
  }
  
  if (!fs.existsSync(OFFLINE_DIR)) {
    fs.mkdirSync(OFFLINE_DIR, { recursive: true });
    console.log('Created /public/backgrounds/offline/');
  }
  
  const NOTFOUND_DIR = path.join(BACKGROUNDS_DIR, '404');
  if (!fs.existsSync(NOTFOUND_DIR)) {
    fs.mkdirSync(NOTFOUND_DIR, { recursive: true });
    console.log('Created /public/backgrounds/404/');
  }
  
  if (!fs.existsSync(IMG_DIR)) {
    console.log('/public/img/ directory not found');
    return;
  }
  
  // 404 images live in the public root, not /public/img.
  const PUBLIC_DIR = path.join(__dirname, '../public');
  const files = fs.readdirSync(IMG_DIR);
  const publicFiles = fs.readdirSync(PUBLIC_DIR);
  let movedLogin = 0;
  let movedOffline = 0;
  let moved404 = 0;
  let skipped = 0;
  
  for (const file of files) {
    const sourcePath = path.join(IMG_DIR, file);
    const stats = fs.statSync(sourcePath);
    
    if (!stats.isFile()) {
      continue;
    }
    
    if (file.match(/^login_bg\d+\.(webp|png|jpg|jpeg)$/i)) {
      const match = file.match(/^login_bg(\d+)\.(.+)$/i);
      if (match) {
        const [, number, ext] = match;
        // Destination filename is the bare index: 1.webp, 2.webp.
        const destFileName = `${number}.${ext}`;
        const destPath = path.join(LOGIN_DIR, destFileName);
        
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(sourcePath, destPath);
          console.log(`   Moved: ${file} -> /backgrounds/login/${destFileName}`);
          movedLogin++;
        } else {
          console.log(`   Skipped: ${file} (destination already exists)`);
          skipped++;
        }
      }
    }
    else if (file.match(/^offline_bg\d+\.(webp|png|jpg|jpeg)$/i)) {
      const match = file.match(/^offline_bg(\d+)\.(.+)$/i);
      if (match) {
        const [, number, ext] = match;
        // Destination filename is the bare index: 1.webp, 2.webp.
        const destFileName = `${number}.${ext}`;
        const destPath = path.join(OFFLINE_DIR, destFileName);
        
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(sourcePath, destPath);
          console.log(`   Moved: ${file} -> /backgrounds/offline/${destFileName}`);
          movedOffline++;
        } else {
          console.log(`   Skipped: ${file} (destination already exists)`);
          skipped++;
        }
      }
    }
  }
  
  for (const file of publicFiles) {
    const sourcePath = path.join(PUBLIC_DIR, file);
    const stats = fs.statSync(sourcePath);
    
    if (!stats.isFile()) {
      continue;
    }
    
    if (file.match(/^404(_\d+)?\.(webp|png|jpg|jpeg)$/i)) {
      const match = file.match(/^404(?:_(\d+))?\.(.+)$/i);
      if (match) {
        const [, number, ext] = match;
        const destFileName = number ? `${number}.${ext}` : `1.${ext}`;
        const destPath = path.join(NOTFOUND_DIR, destFileName);
        
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(sourcePath, destPath);
          console.log(`   Moved: ${file} -> /backgrounds/404/${destFileName}`);
          moved404++;
        } else {
          console.log(`   Skipped: ${file} (destination already exists)`);
          skipped++;
        }
      }
    }
  }
  
  console.log(`\nDone!`);
  console.log(`   Moved ${movedLogin} login backgrounds`);
  console.log(`   Moved ${movedOffline} offline backgrounds`);
  console.log(`   Moved ${moved404} 404 backgrounds`);
  if (skipped > 0) {
    console.log(`   Skipped ${skipped} files (already exist in destination)`);
  }
  console.log(`\nNote: Original files were copied, not moved.`);
  console.log(`   You can manually delete them after verifying the move was successful.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  moveBackgroundImages();
}

export { moveBackgroundImages };

