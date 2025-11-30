#!/usr/bin/env node

/**
 * Generate Mutant Standard Emoji Index
 * 
 * This script scans the mutant_emojis_svg directory and generates
 * an emoji-index.json file that can be loaded by the emoji pack service.
 * 
 * Usage: node scripts/generate-mutant-emoji-index.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EMOJI_DIR = path.join(__dirname, '../public/assets/emojis/mutant_emojis_svg');
const OUTPUT_FILE = path.join(EMOJI_DIR, 'emoji-index.json');

// Directories to exclude (furry variants, gender/sexuality, etc.)
const EXCLUDED_PATHS = [
  'gender_sexuality_relationships',
  'expressions/hands/paw',
  'expressions/hands/hoof',
  'expressions/hands/clw',
  'utils/ligatures',
  'utils/service',
];

// Human-readable category names
const CATEGORY_NAMES = {
  'activities_clothing': 'Activities & Clothing',
  'expressions': 'Expressions',
  'extra': 'Extra',
  'food_drink_herbs': 'Food & Drink',
  'nature_effects': 'Nature & Effects',
  'objects': 'Objects',
  'people_animals': 'People & Animals',
  'symbols': 'Symbols',
  'travel_places': 'Travel & Places',
};

// Subcategory display names
const SUBCATEGORY_NAMES = {
  'clothing': 'Clothing',
  'performing_arts': 'Performing Arts',
  'roles': 'Roles',
  'sports': 'Sports',
  'body_parts': 'Body Parts',
  'hands': 'Hands',
  'no_body': 'Face Only',
  'semi_body': 'Semi Body',
  'smileys': 'Smileys',
  'cyber': 'Cyber',
  'occult_magic': 'Occult & Magic',
  'weapons': 'Weapons',
  'alcohol_herbs': 'Alcohol & Herbs',
  'drink': 'Drinks',
  'food': 'Food',
  'fruit_veg': 'Fruits & Vegetables',
  'other_fresh': 'Other Fresh',
  'earth': 'Earth',
  'effects': 'Effects',
  'moon': 'Moon',
  'plants': 'Plants',
  'weather': 'Weather',
  'art': 'Art',
  'games': 'Games',
  'household': 'Household',
  'mechanisms': 'Mechanisms',
  'money': 'Money',
  'office_stationery': 'Office & Stationery',
  'other': 'Other',
  'party': 'Party',
  'science_medicine': 'Science & Medicine',
  'tech': 'Technology',
  'aspects': 'Aspects',
  'creatures': 'Creatures',
  'arrows': 'Arrows',
  'clock': 'Clock',
  'custom': 'Custom',
  'flags': 'Flags',
  'hearts': 'Hearts',
  'jp': 'Japanese',
  'jp_en': 'Japanese English',
  'media_playback': 'Media Playback',
  'misc': 'Miscellaneous',
  'phone_characters': 'Phone Characters',
  'restrictive': 'Restrictive',
  'shapes': 'Shapes',
  'signs': 'Signs',
  'sound': 'Sound',
  'textual': 'Textual',
  'zodiac': 'Zodiac',
  'air': 'Air',
  'buildings': 'Buildings',
  'locations': 'Locations',
  'road': 'Road',
  'scenes': 'Scenes',
  'space': 'Space',
  'trains': 'Trains',
  'cats': 'Cats',
  'typical': 'Typical',
  'hmn': 'Human',
};

/**
 * Check if a path should be excluded
 */
function shouldExclude(relativePath) {
  return EXCLUDED_PATHS.some(excluded => relativePath.includes(excluded));
}

/**
 * Preferred color variant suffix - y2 is the standard yellow/emoji color
 */
const PREFERRED_COLOR_SUFFIX = '_y2';

/**
 * Excluded variant prefixes (case-insensitive)
 * Fk1 = fantasy/furry variant
 * Ft1 = another variant to exclude
 * Fe1 = Female variant (KEEP this one)
 */
const EXCLUDED_VARIANT_PATTERNS = [
  /_fk\d+\.svg$/i,  // Fk1, Fk2, etc.
  /_ft\d+\.svg$/i,  // Ft1, Ft2, etc.
];

/**
 * Check if filename matches an excluded variant pattern
 */
function isExcludedVariant(filename) {
  return EXCLUDED_VARIANT_PATTERNS.some(pattern => pattern.test(filename));
}

/**
 * Check if a filename is a color/skin tone variant
 * Color variants have suffixes like _b1, _k2, _h1, _r3, etc.
 * We ONLY want _y2 (yellow) variants, or base files for emojis without variants
 */
function isWantedColorVariant(filename, allFilesInDir) {
  // First check if it's an excluded variant (Fk1, Ft1, etc.)
  if (isExcludedVariant(filename)) {
    return false;
  }
  
  const colorVariantPattern = /_[a-z]\d+\.svg$/i;
  const hasColorSuffix = colorVariantPattern.test(filename);
  
  // Get the base name without color suffix
  const baseName = filename.replace(/_[a-z]\d+\.svg$/i, '');
  
  // Check if there's a _y2 version of this emoji in the directory
  const y2Version = baseName + '_y2.svg';
  const hasY2Version = allFilesInDir.includes(y2Version);
  
  if (hasColorSuffix) {
    // If this IS a color variant, only keep _y2
    return filename.endsWith('_y2.svg');
  } else {
    // If this is a base file (no suffix), only keep if there's NO _y2 version
    return !hasY2Version;
  }
}

/**
 * Convert filename to shortcode name (lowercase, underscores, no spaces)
 */
function filenameToShortcode(filename) {
  return filename
    .replace(/\.svg$/i, '')
    .replace(/_y2$/, '')  // Remove _y2 suffix from name
    .toLowerCase();
}

/**
 * Convert filename to display name (for UI, Title Case)
 */
function filenameToDisplayName(filename) {
  return filename
    .replace(/\.svg$/i, '')
    .replace(/_y2$/, '')  // Remove _y2 suffix from display name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Generate keywords from filename and path
 */
function generateKeywords(filename, category, subcategory) {
  const name = filename.replace(/\.svg$/i, '');
  const parts = name.split('_');
  const keywords = [...parts];
  
  // Add category and subcategory as keywords
  if (category) keywords.push(category.replace(/_/g, ' '));
  if (subcategory) keywords.push(subcategory.replace(/_/g, ' '));
  
  return [...new Set(keywords.map(k => k.toLowerCase()))];
}

/**
 * Recursively scan directory for SVG files
 */
function scanDirectory(dir, baseDir, emojis = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  // Get all SVG files in current directory for color variant detection
  const svgFilesInDir = entries
    .filter(e => e.isFile() && e.name.endsWith('.svg'))
    .map(e => e.name);
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    
    // Check exclusions
    if (shouldExclude(relativePath)) {
      console.log(`  ⏭️ Skipping excluded path: ${relativePath}`);
      continue;
    }
    
    if (entry.isDirectory()) {
      // Recurse into subdirectory
      scanDirectory(fullPath, baseDir, emojis);
    } else if (entry.isFile() && entry.name.endsWith('.svg')) {
      // Only include _y2 variants (yellow), or base files if no _y2 exists
      if (!isWantedColorVariant(entry.name, svgFilesInDir)) {
        continue;
      }
      
      // Parse the relative path to get category/subcategory
      const pathParts = relativePath.split(path.sep);
      const category = pathParts[0] || 'other';
      const subcategory = pathParts.length > 2 ? pathParts.slice(1, -1).join('/') : undefined;
      const filename = entry.name;
      
      // Use shortcode format for id (lowercase, underscores)
      const shortcode = filenameToShortcode(filename);
      
      const emojiItem = {
        id: shortcode,
        name: shortcode,  // Use shortcode as name for consistency
        displayName: filenameToDisplayName(filename),  // Keep display name for UI
        category: category,
        subcategory: subcategory,
        path: relativePath.replace(/\\/g, '/'), // Normalize path separators
        keywords: generateKeywords(filename, category, subcategory)
      };
      
      emojis.push(emojiItem);
    }
  }
  
  return emojis;
}

/**
 * Main function
 */
function main() {
  console.log('🎨 Generating Mutant Standard Emoji Index...\n');
  
  if (!fs.existsSync(EMOJI_DIR)) {
    console.error(`❌ Emoji directory not found: ${EMOJI_DIR}`);
    process.exit(1);
  }
  
  console.log(`📁 Scanning: ${EMOJI_DIR}`);
  console.log(`📋 Excluding paths:`);
  EXCLUDED_PATHS.forEach(p => console.log(`   - ${p}`));
  console.log('');
  
  const emojis = scanDirectory(EMOJI_DIR, EMOJI_DIR);
  
  // Sort by category, then subcategory, then name
  emojis.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.subcategory !== b.subcategory) return (a.subcategory || '').localeCompare(b.subcategory || '');
    return a.name.localeCompare(b.name);
  });
  
  // Generate category summary
  const categorySummary = {};
  for (const emoji of emojis) {
    if (!categorySummary[emoji.category]) {
      categorySummary[emoji.category] = { count: 0, subcategories: new Set() };
    }
    categorySummary[emoji.category].count++;
    if (emoji.subcategory) {
      categorySummary[emoji.category].subcategories.add(emoji.subcategory);
    }
  }
  
  console.log('📊 Category Summary:');
  for (const [cat, info] of Object.entries(categorySummary)) {
    const displayName = CATEGORY_NAMES[cat] || cat;
    console.log(`   ${displayName}: ${info.count} emojis`);
    if (info.subcategories.size > 0) {
      console.log(`      Subcategories: ${[...info.subcategories].join(', ')}`);
    }
  }
  
  // Write the index file
  const indexData = {
    version: '1.0.0',
    pack: 'mutant',
    generatedAt: new Date().toISOString(),
    totalCount: emojis.length,
    categories: Object.keys(categorySummary).map(cat => ({
      id: cat,
      name: CATEGORY_NAMES[cat] || cat,
      count: categorySummary[cat].count,
      subcategories: [...categorySummary[cat].subcategories].map(sub => ({
        id: sub,
        name: SUBCATEGORY_NAMES[sub.split('/').pop()] || sub
      }))
    })),
    emojis: emojis
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(indexData, null, 2));
  
  console.log(`\n✅ Generated emoji index with ${emojis.length} emojis`);
  console.log(`📄 Output: ${OUTPUT_FILE}`);
}

main();

