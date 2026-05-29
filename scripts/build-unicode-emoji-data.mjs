#!/usr/bin/env node
/**
 * Build Unicode Emoji Data
 * 
 * Creates a single source of truth JSON file for all Unicode emojis.
 * This is pack-agnostic - it provides the emoji data that all packs
 * (twemoji, native) use for rendering.
 * 
 * Categories follow Unicode standard order:
 * 1. People (Smileys & Emotion, People & Body)
 * 2. Nature (Animals & Nature)
 * 3. Food (Food & Drink)
 * 4. Activities
 * 5. Travel (Travel & Places)
 * 6. Objects
 * 7. Symbols
 * 8. Flags
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Load the unicode emoji data using require (handles JSON properly)
const unicodeEmoji = require('unicode-emoji-json');

// gemoji ships GitHub-style shortcodes (`+1`, `joy`, `thumbsup`, ...) that
// every popular chat client recognizes. Merging these into our shortcode
// lookup is what makes `:joy:` resolve to 😂 without us hard-coding the list.
const { gemoji } = await import('gemoji');

const OUTPUT_DIR = path.join(__dirname, '../public/assets/emojis');
const TWEMOJI_DIR = path.join(OUTPUT_DIR, 'twemoji');

/**
 * Scan Twemoji SVG files and build a set of available filenames
 * The service will handle fe0f normalization at runtime
 */
function buildTwemojiFileMap() {
  console.log('📁 Scanning Twemoji SVG files...');
  
  if (!fs.existsSync(TWEMOJI_DIR)) {
    console.warn('⚠️ Twemoji directory not found, skipping file map generation');
    return null;
  }
  
  const files = fs.readdirSync(TWEMOJI_DIR).filter(f => f.endsWith('.svg'));
  console.log(`   Found ${files.length} SVG files`);
  
  // Build a set of available codepoints (without .svg extension)
  // The service will try multiple fe0f variations to find a match
  const available = {};
  
  for (const file of files) {
    const codepoint = file.replace('.svg', '');
    available[codepoint] = true;
  }
  
  console.log(`   Created ${Object.keys(available).length} lookup entries\n`);
  return available;
}

/**
 * Category mapping from Unicode standard groups to our simplified categories
 */
const CATEGORY_MAPPING = {
  // People category
  'Smileys & Emotion': 'people',
  'People & Body': 'people',
  
  // Nature category
  'Animals & Nature': 'nature',
  
  // Food category
  'Food & Drink': 'food',
  
  // Activities category
  'Activities': 'activities',
  
  // Travel category
  'Travel & Places': 'travel',
  
  // Objects category
  'Objects': 'objects',
  
  // Symbols category
  'Symbols': 'symbols',
  
  // Flags category
  'Flags': 'flags',
  
  // Component emojis (skin tones, hair styles) - include in people
  'Component': 'people'
};

/**
 * Category definitions with order and icons
 */
const CATEGORIES = [
  { id: 'people', name: 'People', icon: '😀', order: 0 },
  { id: 'nature', name: 'Nature', icon: '🐱', order: 1 },
  { id: 'food', name: 'Food', icon: '🍔', order: 2 },
  { id: 'activities', name: 'Activities', icon: '⚽', order: 3 },
  { id: 'travel', name: 'Travel', icon: '🚗', order: 4 },
  { id: 'objects', name: 'Objects', icon: '💡', order: 5 },
  { id: 'symbols', name: 'Symbols', icon: '❤️', order: 6 },
  { id: 'flags', name: 'Flags', icon: '🏳️', order: 7 }
];

/**
 * Convert unicode emoji to hex codepoint string
 * Handles multi-codepoint emojis (ZWJ sequences, skin tones, etc.)
 */
function emojiToCodepoint(unicode) {
  const codepoints = [];
  for (const char of unicode) {
    const cp = char.codePointAt(0);
    if (cp !== undefined) {
      // Skip variation selectors for cleaner codepoints (except FE0F which is needed)
      codepoints.push(cp.toString(16).toLowerCase());
    }
  }
  return codepoints.join('-');
}

/**
 * Generate shortcode from emoji name
 */
function nameToShortcode(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // Remove special chars
    .replace(/\s+/g, '_')          // Replace spaces with underscores
    .replace(/-+/g, '_')           // Replace dashes with underscores
    .replace(/_+/g, '_')           // Collapse multiple underscores
    .replace(/^_|_$/g, '');        // Trim underscores
}

/**
 * Main function
 */
function main() {
  console.log('🎨 Building Unicode Emoji Data...\n');
  
  // Build Twemoji file map first
  const twemojiFileMap = buildTwemojiFileMap();
  
  // Build a unicode → gemoji entry map so we can attach GitHub aliases
  // (`names` + `tags`) as keywords on each emoji.
  const gemojiByUnicode = new Map();
  for (const g of gemoji) {
    gemojiByUnicode.set(g.emoji, g);
  }

  const emojis = [];
  const shortcodeToUnicode = {};
  const unicodeToShortcode = {};
  const unicodeToCodepoint = {};
  const categoryCounts = {};
  
  // Initialize category counts
  CATEGORIES.forEach(cat => {
    categoryCounts[cat.id] = 0;
  });
  
  // Process all emojis
  const emojiEntries = Object.entries(unicodeEmoji);
  console.log(`📊 Processing ${emojiEntries.length} emojis from unicode-emoji-json...\n`);
  
  for (const [unicode, data] of emojiEntries) {
    // Map the Unicode group to our category
    const category = CATEGORY_MAPPING[data.group];
    
    if (!category) {
      console.warn(`⚠️ Unknown group: ${data.group} for emoji ${unicode}`);
      continue;
    }
    
    // Generate shortcode from name
    const shortcode = nameToShortcode(data.name);

    // Pull GitHub/Discord-style aliases from gemoji for this emoji
    const gemojiEntry = gemojiByUnicode.get(unicode);
    const githubAliases = gemojiEntry?.names ?? [];
    const githubTags = gemojiEntry?.tags ?? [];

    const baseKeywords = [
      shortcode,
      ...data.name.toLowerCase().split(' '),
      ...githubAliases,
      ...githubTags,
    ].filter(Boolean);
    // Dedup keywords (case-insensitive)
    const seenKw = new Set();
    const keywords = baseKeywords.filter(kw => {
      const key = kw.toLowerCase();
      if (seenKw.has(key)) return false;
      seenKw.add(key);
      return true;
    });

    // Skip if shortcode already exists (handle duplicates)
    if (shortcodeToUnicode[shortcode]) {
      // Append number to make unique
      let uniqueShortcode = shortcode;
      let counter = 2;
      while (shortcodeToUnicode[uniqueShortcode]) {
        uniqueShortcode = `${shortcode}_${counter}`;
        counter++;
      }
      // Use the unique shortcode
      const codepoint = emojiToCodepoint(unicode);

      emojis.push({
        unicode,
        shortcode: uniqueShortcode,
        name: data.name,
        category,
        codepoint,
        keywords,
        skinToneSupport: data.skin_tone_support || false
      });

      shortcodeToUnicode[uniqueShortcode] = unicode;
      unicodeToShortcode[unicode] = uniqueShortcode;
      unicodeToCodepoint[unicode] = codepoint;
      categoryCounts[category]++;
      continue;
    }

    const codepoint = emojiToCodepoint(unicode);

    emojis.push({
      unicode,
      shortcode,
      name: data.name,
      category,
      codepoint,
      keywords,
      skinToneSupport: data.skin_tone_support || false
    });

    // Build lookup maps
    shortcodeToUnicode[shortcode] = unicode;
    unicodeToShortcode[unicode] = shortcode;
    unicodeToCodepoint[unicode] = codepoint;
    categoryCounts[category]++;
  }

  // Register GitHub/Discord-style aliases as additional shortcode lookup
  // entries. We do this AFTER the main pass so we never overwrite the
  // canonical Unicode-derived shortcode (e.g. `grinning_face` keeps its
  // mapping; `:grinning:` is added as an alias).
  let aliasCount = 0;
  for (const entry of gemoji) {
    const names = entry.names ?? [];
    for (const alias of names) {
      if (!alias) continue;
      // Normalize alias to match `[a-zA-Z0-9_+-]+` (the inner shortcode regex).
      // gemoji aliases already match this, but defensively skip anything weird.
      if (!/^[a-zA-Z0-9_+-]+$/.test(alias)) continue;
      if (!shortcodeToUnicode[alias]) {
        shortcodeToUnicode[alias] = entry.emoji;
        aliasCount++;
      }
    }
  }
  console.log(`📎 Added ${aliasCount} GitHub/Discord-style shortcode aliases`);
  
  // Sort emojis by category order, then by their position in the original data
  emojis.sort((a, b) => {
    const catA = CATEGORIES.find(c => c.id === a.category)?.order ?? 99;
    const catB = CATEGORIES.find(c => c.id === b.category)?.order ?? 99;
    return catA - catB;
  });
  
  // Update category counts
  const categoriesWithCount = CATEGORIES.map(cat => ({
    ...cat,
    count: categoryCounts[cat.id] || 0
  }));
  
  console.log('📊 Category Summary:');
  categoriesWithCount.forEach(cat => {
    console.log(`   ${cat.icon} ${cat.name}: ${cat.count} emojis`);
  });
  
  // Build output
  const output = {
    version: '15.1',
    source: 'unicode-emoji-json',
    generatedAt: new Date().toISOString(),
    totalCount: emojis.length,
    categories: categoriesWithCount,
    emojis,
    lookups: {
      shortcodeToUnicode,
      unicodeToShortcode,
      unicodeToCodepoint
    }
  };
  
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  // Write main data file
  const outputPath = path.join(OUTPUT_DIR, 'unicode-emoji-data.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Generated: ${outputPath}`);
  console.log(`   Total emojis: ${emojis.length}`);
  
  // Write lightweight lookups file (for faster initial load)
  const lookupsPath = path.join(OUTPUT_DIR, 'unicode-emoji-lookups.json');
  fs.writeFileSync(lookupsPath, JSON.stringify({
    version: '15.1',
    shortcodeToUnicode,
    unicodeToShortcode,
    unicodeToCodepoint
  }, null, 2));
  console.log(`✅ Generated: ${lookupsPath}`);
  
  // Write Twemoji file map (for accurate SVG path resolution)
  if (twemojiFileMap) {
    const twemojiMapPath = path.join(OUTPUT_DIR, 'twemoji-file-map.json');
    fs.writeFileSync(twemojiMapPath, JSON.stringify(twemojiFileMap, null, 2));
    console.log(`✅ Generated: ${twemojiMapPath}`);
  }
  
  console.log('\n🎉 Done!');
}

main();

