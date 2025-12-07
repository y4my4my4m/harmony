#!/usr/bin/env node
/**
 * Build Background Images Manifest
 * 
 * Scans the /public/backgrounds/ directory and generates a manifest JSON file
 * that lists all available background images. This avoids runtime discovery.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKGROUNDS_DIR = path.join(__dirname, '../public/backgrounds');
const OUTPUT_FILE = path.join(__dirname, '../public/backgrounds/manifest.json');

const imageExtensions = ['.webp', '.png', '.jpg', '.jpeg'];

/**
 * Recursively scan a directory for image files
 */
function scanDirectory(dirPath, relativePath = '') {
  const images = [];
  
  if (!fs.existsSync(dirPath)) {
    return images;
  }
  
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativeFilePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    
    if (entry.isDirectory()) {
      // Recursively scan subdirectories
      images.push(...scanDirectory(fullPath, relativeFilePath));
    } else if (entry.isFile()) {
      // Check if it's an image file
      const ext = path.extname(entry.name).toLowerCase();
      if (imageExtensions.includes(ext)) {
        images.push(`/backgrounds/${relativeFilePath}`);
      }
    }
  }
  
  return images;
}

/**
 * Build the manifest
 */
function buildManifest() {
  console.log('📁 Scanning background images...');
  
  const manifest = {
    login: [],
    offline: [],
    notFound: [],
    generatedAt: new Date().toISOString()
  };
  
  // Scan login folder
  const loginDir = path.join(BACKGROUNDS_DIR, 'login');
  if (fs.existsSync(loginDir)) {
    manifest.login = scanDirectory(loginDir, 'login');
    console.log(`   Found ${manifest.login.length} login backgrounds`);
  } else {
    console.log('   No /backgrounds/login folder found');
  }
  
  // Scan offline folder
  const offlineDir = path.join(BACKGROUNDS_DIR, 'offline');
  if (fs.existsSync(offlineDir)) {
    manifest.offline = scanDirectory(offlineDir, 'offline');
    console.log(`   Found ${manifest.offline.length} offline backgrounds`);
  } else {
    console.log('   No /backgrounds/offline folder found');
  }
  
  // Scan 404 folder
  const notFoundDir = path.join(BACKGROUNDS_DIR, '404');
  if (fs.existsSync(notFoundDir)) {
    manifest.notFound = scanDirectory(notFoundDir, '404');
    console.log(`   Found ${manifest.notFound.length} 404 backgrounds`);
  } else {
    console.log('   No /backgrounds/404 folder found');
  }
  
  // Ensure backgrounds directory exists
  if (!fs.existsSync(BACKGROUNDS_DIR)) {
    fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });
  }
  
  // Write manifest
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2));
  console.log(`✅ Manifest written to ${OUTPUT_FILE}\n`);
  
  return manifest;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  buildManifest();
}

export { buildManifest };

