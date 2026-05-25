#!/usr/bin/env node
/**
 * Process Mutant Standard Emoji Data
 * 
 * Reads the official mtnt_2024.06_data.json and creates:
 * 1. A filtered emoji index with unicode mappings
 * 2. Lookup maps for shortcode ↔ unicode ↔ SVG path
 * 
 * This enables the emoji system to:
 * - Store reactions as standard unicode (works across packs)
 * - Render using native unicode OR mutant SVG based on user preference
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_FILE = path.join(__dirname, '../public/assets/emojis/mtnt_2024.06_data.json');
const OUTPUT_DIR = path.join(__dirname, '../public/assets/emojis');

// Categories to exclude (use the 'cat' field from source data)
const EXCLUDED_CATEGORIES = [
  'gsr',           // gender_sexuality_relationships
  'utils',         // utility emojis
];

const EXCLUDED_SRC_PATTERNS = [
  '/hands/paw/',
  '/hands/hoof/',
  '/hands/clw/',
  '/hands/fk/',   // Fantasy/furry variants
  '/hands/ft/',   // Other variants to exclude
];

// Skin tone variant suffixes in shortcode (like _r1, _r2, _b1, _k2, etc.)
// Keep only base shortcodes (no _X# suffix) OR _y2 (standard yellow)
const SKIN_TONE_SHORTCODE_PATTERN = /_[bcdeghklmoprstvy]\d+$/;

// Only include these bundles (core has the standard emojis)
const INCLUDED_BUNDLES = ['core', 'extra'];

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
 * Check if an emoji should be excluded
 */
function shouldExclude(emoji, allEmojis) {
  // Check category
  if (EXCLUDED_CATEGORIES.includes(emoji.cat)) {
    return true;
  }
  
  // Check source path patterns
  if (emoji.src) {
    for (const pattern of EXCLUDED_SRC_PATTERNS) {
      if (emoji.src.includes(pattern)) {
        return true;
      }
    }
  }
  
  // Only include specified bundles
  if (!INCLUDED_BUNDLES.includes(emoji.bundle)) {
    return true;
  }
  
  // Handle skin tone variants in shortcode (like hand_hmn_r1, hand_hmn_k2, etc.)
  // Keep only base shortcodes OR _y2 (standard yellow)
  const shortcode = emoji.short || '';
  if (SKIN_TONE_SHORTCODE_PATTERN.test(shortcode)) {
    // This is a skin tone variant - only keep _y2
    if (!shortcode.endsWith('_y2')) {
      return true;
    }
  }
  
  return false;
}

/**
 * Extract category from source path
 */
function extractCategory(src) {
  const parts = src.split('/');
  return parts[0] || 'other';
}

/**
 * Extract subcategory from source path
 */
function extractSubcategory(src) {
  const parts = src.split('/');
  if (parts.length > 2) {
    return parts.slice(1, -1).join('/');
  }
  return null;
}

/**
 * Main processing function
 */
function processEmojiData() {
  console.log('🎨 Processing Mutant Standard Emoji Data...\n');
  
  // Read input file
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }
  
  const rawData = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  console.log(`📁 Loaded ${rawData.length} emojis from source data`);
  
  // Process emojis
  const emojis = [];
  const shortcodeToUnicode = {};
  const unicodeToShortcode = {};
  const shortcodeToSvg = {};
  const categories = new Map();
  
  let excluded = 0;
  let noUnicode = 0;
  
  for (const emoji of rawData) {
    // Skip excluded emojis
    if (shouldExclude(emoji, rawData)) {
      excluded++;
      continue;
    }
    
    // Get unicode character
    const unicode = codepointsToEmoji(emoji.code);
    if (!unicode) {
      noUnicode++;
      continue;
    }
    
    const shortcode = emoji.short;
    const category = emoji.cat || extractCategory(emoji.src);  // Prefer metadata category
    const subcategory = extractSubcategory(emoji.src);
    
    // Build emoji entry
    const entry = {
      shortcode,
      unicode,
      codepoints: emoji.code,
      description: emoji.desc,
      category,
      subcategory,
      svgPath: emoji.src,
      keywords: [shortcode, ...emoji.desc.toLowerCase().split(' ')].filter(Boolean)
    };
    
    emojis.push(entry);
    
    // Build lookup maps
    shortcodeToUnicode[shortcode] = unicode;
    unicodeToShortcode[unicode] = shortcode;
    shortcodeToSvg[shortcode] = emoji.src;
    
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
  console.log(`   Total in source: ${rawData.length}`);
  console.log(`   Excluded: ${excluded}`);
  console.log(`   No unicode: ${noUnicode}`);
  console.log(`   Final count: ${emojis.length}`);
  
  console.log(`\n📊 Category Summary:`);
  for (const [cat, data] of categories) {
    console.log(`   ${cat}: ${data.count} emojis`);
    if (data.subcategories.size > 0) {
      console.log(`      Subcategories: ${[...data.subcategories].join(', ')}`);
    }
  }
  
  // Build output data
  const output = {
    version: '1.0.0',
    pack: 'mutant',
    source: 'mtnt_2024.06_data.json',
    generatedAt: new Date().toISOString(),
    totalCount: emojis.length,
    
    // Categorized emoji list
    categories: Array.from(categories.entries()).map(([id, data]) => ({
      id,
      name: id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      count: data.count,
      subcategories: [...data.subcategories]
    })),
    
    // All emojis
    emojis,
    
    // Lookup maps for fast access
    lookups: {
      shortcodeToUnicode,
      unicodeToShortcode,
      shortcodeToSvg
    }
  };
  
  // Write main emoji data file
  const outputPath = path.join(OUTPUT_DIR, 'emoji-data.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Generated emoji data: ${outputPath}`);
  
  // Write compact lookup-only file (for runtime use)
  const lookupsPath = path.join(OUTPUT_DIR, 'emoji-lookups.json');
  fs.writeFileSync(lookupsPath, JSON.stringify({
    shortcodeToUnicode,
    unicodeToShortcode,
    shortcodeToSvg,
    svgBasePath: '/assets/emojis/mutant_emojis_svg'
  }, null, 2));
  console.log(`✅ Generated lookup maps: ${lookupsPath}`);
  
  console.log(`\n🎉 Done! ${emojis.length} emojis processed.`);
}

// Run
processEmojiData();

