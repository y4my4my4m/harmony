#!/usr/bin/env node
/**
 * Move Background Images to Organized Folders
 * 
 * Moves existing background images from /public/img/ to organized folders:
 * - login_bg*.webp -> /public/backgrounds/login/
 * - offline_bg*.webp -> /public/backgrounds/offline/
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

/**
 * Move background images to organized folders
 */
function moveBackgroundImages() {
  console.log('📁 Moving background images to organized folders...\n');
  
  // Ensure destination directories exist
  if (!fs.existsSync(LOGIN_DIR)) {
    fs.mkdirSync(LOGIN_DIR, { recursive: true });
    console.log('✅ Created /public/backgrounds/login/');
  }
  
  if (!fs.existsSync(OFFLINE_DIR)) {
    fs.mkdirSync(OFFLINE_DIR, { recursive: true });
    console.log('✅ Created /public/backgrounds/offline/');
  }
  
  const NOTFOUND_DIR = path.join(BACKGROUNDS_DIR, '404');
  if (!fs.existsSync(NOTFOUND_DIR)) {
    fs.mkdirSync(NOTFOUND_DIR, { recursive: true });
    console.log('✅ Created /public/backgrounds/404/');
  }
  
  if (!fs.existsSync(IMG_DIR)) {
    console.log('❌ /public/img/ directory not found');
    return;
  }
  
  // Also check public root for 404 images
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
    
    // Only process files (not directories)
    if (!stats.isFile()) {
      continue;
    }
    
    // Check if it's a login background
    if (file.match(/^login_bg\d+\.(webp|png|jpg|jpeg)$/i)) {
      // Extract the number and extension
      const match = file.match(/^login_bg(\d+)\.(.+)$/i);
      if (match) {
        const [, number, ext] = match;
        // Use just the number as the filename (e.g., 1.webp, 2.webp)
        const destFileName = `${number}.${ext}`;
        const destPath = path.join(LOGIN_DIR, destFileName);
        
        // Only move if destination doesn't exist
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
    // Check if it's an offline background
    else if (file.match(/^offline_bg\d+\.(webp|png|jpg|jpeg)$/i)) {
      // Extract the number and extension
      const match = file.match(/^offline_bg(\d+)\.(.+)$/i);
      if (match) {
        const [, number, ext] = match;
        // Use just the number as the filename (e.g., 1.webp, 2.webp)
        const destFileName = `${number}.${ext}`;
        const destPath = path.join(OFFLINE_DIR, destFileName);
        
        // Only move if destination doesn't exist
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
  
  // Process 404 images from public root
  for (const file of publicFiles) {
    const sourcePath = path.join(PUBLIC_DIR, file);
    const stats = fs.statSync(sourcePath);
    
    // Only process files (not directories)
    if (!stats.isFile()) {
      continue;
    }
    
    // Check if it's a 404 image
    if (file.match(/^404(_\d+)?\.(webp|png|jpg|jpeg)$/i)) {
      // Extract the number and extension
      const match = file.match(/^404(?:_(\d+))?\.(.+)$/i);
      if (match) {
        const [, number, ext] = match;
        // Use number if present, otherwise use 1
        const destFileName = number ? `${number}.${ext}` : `1.${ext}`;
        const destPath = path.join(NOTFOUND_DIR, destFileName);
        
        // Only move if destination doesn't exist
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
  
  console.log(`\n✅ Done!`);
  console.log(`   Moved ${movedLogin} login backgrounds`);
  console.log(`   Moved ${movedOffline} offline backgrounds`);
  console.log(`   Moved ${moved404} 404 backgrounds`);
  if (skipped > 0) {
    console.log(`   Skipped ${skipped} files (already exist in destination)`);
  }
  console.log(`\n💡 Note: Original files were copied, not moved.`);
  console.log(`   You can manually delete them after verifying the move was successful.\n`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  moveBackgroundImages();
}

export { moveBackgroundImages };

