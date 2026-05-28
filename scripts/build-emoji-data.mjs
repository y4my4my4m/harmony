#!/usr/bin/env node
/**
 * Build Emoji Data
 * 
 * Scans actual SVG files on disk AND uses official metadata for unicode mappings.
 * This ensures paths are correct AND we have unicode<->shortcode mappings.
 * 
 * Strategy:
 * 1. Scan actual files on disk to get real paths
 * 2. Match with official metadata to get unicode codepoints
 * 3. Prefer _y2 (yellow) variants, copy them as default if needed
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EMOJI_DIR = path.join(__dirname, '../public/assets/emojis/mutant_emojis_svg');
const METADATA_FILE = path.join(__dirname, '../public/assets/emojis/mtnt_2024.06_data.json');
const OUTPUT_DIR = path.join(__dirname, '../public/assets/emojis');

// Categories/paths to exclude
const EXCLUDED_PATHS = [
  'gender_sexuality_relationships',
  'gsr',
  'expressions/hands/paw',
  'expressions/hands/hoof', 
  'expressions/hands/clw',
  'utils/ligatures',
  'utils/service',
];

// Skin tone variant suffixes to exclude (keep only _y2 or no suffix)
const EXCLUDED_VARIANT_PATTERN = /_[bcdeghklmoprstv]\d+\.svg$/i;

// Only include these bundles from metadata
const INCLUDED_BUNDLES = ['core', 'extra'];

/**
 * Check if path should be excluded
 */
function shouldExcludePath(relativePath) {
  return EXCLUDED_PATHS.some(excluded => relativePath.includes(excluded));
}

/**
 * Check if filename is an excluded variant (not _y2)
 */
function isExcludedVariant(filename) {
  // Exclude non-y2 skin tone variants
  if (EXCLUDED_VARIANT_PATTERN.test(filename)) {
    return true;
  }
  // Also exclude _fk and _ft variants
  if (/_f[kt]\d*\.svg$/i.test(filename)) {
    return true;
  }
  return false;
}

/**
 * Convert unicode codepoints array to emoji character
 */
function codepointsToEmoji(codepoints) {
  if (!codepoints || codepoints.length === 0) return null;
  try {
    return String.fromCodePoint(...codepoints);
  } catch (e) {
    return null;
  }
}

/**
 * Build shortcode lookup from metadata
 * Strips unicode prefix from paths to match actual filenames
 */
function buildMetadataLookup(metadata) {
  const lookup = new Map(); // shortcode -> { unicode, codepoints }
  
  for (const entry of metadata) {
    // Skip excluded bundles
    if (!INCLUDED_BUNDLES.includes(entry.bundle)) continue;
    
    const shortcode = entry.short;
    const unicode = codepointsToEmoji(entry.code);
    
    // Only include base shortcodes (not variant suffixes)
    // Skip entries with skin tone suffixes in shortcode
    if (/_[bcdeghklmoprstvy]\d+$/.test(shortcode)) continue;
    
    if (unicode && shortcode) {
      lookup.set(shortcode, {
        unicode,
        codepoints: entry.code,
        description: entry.desc,
        category: entry.cat
      });
    }
  }
  
  return lookup;
}

/**
 * Extract shortcode from filename
 * Handles: file.svg, file_y2.svg
 */
function filenameToShortcode(filename) {
  return filename
    .replace(/\.svg$/i, '')
    .replace(/_y2$/, '')  // Remove _y2 suffix
    .toLowerCase();
}

/**
 * Recursively scan directory for SVG files
 */
function scanDirectory(dir, baseDir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  // Get all SVG files in current directory for _y2 detection
  const svgFiles = entries.filter(e => e.isFile() && e.name.endsWith('.svg')).map(e => e.name);
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    
    // Check exclusions
    if (shouldExcludePath(relativePath)) {
      continue;
    }
    
    if (entry.isDirectory()) {
      scanDirectory(fullPath, baseDir, files);
    } else if (entry.isFile() && entry.name.endsWith('.svg')) {
      // Skip excluded variants (non-y2 skin tones)
      if (isExcludedVariant(entry.name)) {
        continue;
      }
      
      const shortcode = filenameToShortcode(entry.name);
      const isY2 = entry.name.includes('_y2');
      
      // Check if there's a _y2 version
      const y2Version = entry.name.replace('.svg', '_y2.svg').replace('_y2_y2', '_y2');
      const hasY2 = svgFiles.includes(y2Version) || svgFiles.includes(shortcode + '_y2.svg');
      
      // If this is a base file (no _y2) and a _y2 version exists, skip it
      if (!isY2 && hasY2) {
        continue;
      }
      
      files.push({
        filename: entry.name,
        shortcode,
        relativePath: relativePath.replace(/\\/g, '/'),
        isY2
      });
    }
  }
  
  return files;
}

/**
 * Extract category from path
 */
function extractCategory(relativePath) {
  const parts = relativePath.split('/');
  return parts[0] || 'other';
}

/**
 * Extract subcategory from path
 */
function extractSubcategory(relativePath) {
  const parts = relativePath.split('/');
  if (parts.length > 2) {
    return parts.slice(1, -1).join('/');
  }
  return null;
}

/**
 * Generate keywords from shortcode
 */
function generateKeywords(shortcode, description) {
  const words = new Set();
  
  // Add shortcode parts
  shortcode.split('_').forEach(w => words.add(w.toLowerCase()));
  
  // Add description words
  if (description) {
    description.toLowerCase().split(/\s+/).forEach(w => {
      if (w.length > 2) words.add(w);
    });
  }
  
  return [...words];
}

/**
 * Main function
 */
function main() {
  console.log('🎨 Building Unified Emoji Data...\n');
  
  // Load metadata
  console.log('📁 Loading official metadata...');
  let metadata = [];
  if (fs.existsSync(METADATA_FILE)) {
    metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    console.log(`   Loaded ${metadata.length} entries from metadata`);
  } else {
    console.warn('⚠️ Metadata file not found, unicode mappings will be limited');
  }
  
  const metadataLookup = buildMetadataLookup(metadata);
  console.log(`   Built lookup with ${metadataLookup.size} shortcodes`);
  
  // Scan actual files
  console.log('\n📁 Scanning SVG files...');
  const files = scanDirectory(EMOJI_DIR, EMOJI_DIR);
  console.log(`   Found ${files.length} emoji files`);
  
  // Build emoji data
  const emojis = [];
  const shortcodeToUnicode = {};
  const unicodeToShortcode = {};
  const shortcodeToSvg = {};
  const categories = new Map();
  
  let withUnicode = 0;
  let withoutUnicode = 0;
  
  for (const file of files) {
    const category = extractCategory(file.relativePath);
    const subcategory = extractSubcategory(file.relativePath);
    
    // Look up unicode from metadata
    const meta = metadataLookup.get(file.shortcode);
    const unicode = meta?.unicode || null;
    const description = meta?.description || file.shortcode.replace(/_/g, ' ');
    
    if (unicode) {
      withUnicode++;
    } else {
      withoutUnicode++;
    }
    
    const entry = {
      shortcode: file.shortcode,
      unicode: unicode,
      codepoints: meta?.codepoints || [],
      description,
      category,
      subcategory,
      svgPath: file.relativePath,
      keywords: generateKeywords(file.shortcode, description)
    };
    
    emojis.push(entry);
    
    // Build lookup maps (only for emojis with unicode)
    if (unicode) {
      shortcodeToUnicode[file.shortcode] = unicode;
      unicodeToShortcode[unicode] = file.shortcode;
    }
    shortcodeToSvg[file.shortcode] = file.relativePath;
    
    // Track categories
    if (!categories.has(category)) {
      categories.set(category, { count: 0, subcategories: new Set() });
    }
    categories.get(category).count++;
    if (subcategory) {
      categories.get(category).subcategories.add(subcategory);
    }
  }
  
  console.log(`\n📊 Processing Summary:`);
  console.log(`   Total emojis: ${emojis.length}`);
  console.log(`   With unicode mapping: ${withUnicode}`);
  console.log(`   Without unicode (Mutant-only): ${withoutUnicode}`);
  
  console.log(`\n📊 Category Summary:`);
  for (const [cat, data] of categories) {
    console.log(`   ${cat}: ${data.count} emojis`);
    if (data.subcategories.size > 0) {
      console.log(`      Subcategories: ${[...data.subcategories].slice(0, 5).join(', ')}${data.subcategories.size > 5 ? '...' : ''}`);
    }
  }
  
  // Build output
  const output = {
    version: '2.0.0',
    pack: 'mutant',
    source: 'file-scan + mtnt_2024.06_data.json',
    generatedAt: new Date().toISOString(),
    totalCount: emojis.length,
    
    categories: Array.from(categories.entries()).map(([id, data]) => ({
      id,
      name: id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      count: data.count,
      subcategories: [...data.subcategories]
    })),
    
    emojis,
    
    lookups: {
      shortcodeToUnicode,
      unicodeToShortcode,
      shortcodeToSvg
    }
  };
  
  // Write files
  const dataPath = path.join(OUTPUT_DIR, 'emoji-data.json');
  fs.writeFileSync(dataPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Generated: ${dataPath}`);
  
  const lookupsPath = path.join(OUTPUT_DIR, 'emoji-lookups.json');
  fs.writeFileSync(lookupsPath, JSON.stringify({
    shortcodeToUnicode,
    unicodeToShortcode,
    shortcodeToSvg,
    svgBasePath: '/assets/emojis/mutant_emojis_svg'
  }, null, 2));
  console.log(`✅ Generated: ${lookupsPath}`);
  
  console.log(`\n🎉 Done! ${emojis.length} emojis processed.`);
}

main();

