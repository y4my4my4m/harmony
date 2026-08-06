#!/usr/bin/env node
/**
 * Build Unicode Emoji Data
 *
 * Emits the single source of truth JSON for all Unicode emojis. Pack-agnostic:
 * both the twemoji and native packs render from this data.
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

// require() for the JSON payload; ESM import of JSON needs an import assertion.
const unicodeEmoji = require('unicode-emoji-json');

// gemoji supplies GitHub-style shortcodes (`+1`, `joy`, `thumbsup`, ...).
// Merging them into the shortcode lookup resolves `:joy:` to 😂 without a
// hard-coded list.
const { gemoji } = await import('gemoji');

const OUTPUT_DIR = path.join(__dirname, '../public/assets/emojis');
const TWEMOJI_DIR = path.join(OUTPUT_DIR, 'twemoji');

/**
 * Set of codepoint filenames present in the Twemoji SVG directory.
 * fe0f normalization happens at runtime in the emoji service.
 */
function buildTwemojiFileMap() {
  console.log('Scanning Twemoji SVG files...');
  
  if (!fs.existsSync(TWEMOJI_DIR)) {
    console.warn('Twemoji directory not found, skipping file map generation');
    return null;
  }
  
  const files = fs.readdirSync(TWEMOJI_DIR).filter(f => f.endsWith('.svg'));
  console.log(`   Found ${files.length} SVG files`);
  
  // Keys are codepoints without the .svg extension.
  const available = {};
  
  for (const file of files) {
    const codepoint = file.replace('.svg', '');
    available[codepoint] = true;
  }
  
  console.log(`   Created ${Object.keys(available).length} lookup entries\n`);
  return available;
}

/** Unicode standard group -> internal category id. */
const CATEGORY_MAPPING = {
  'Smileys & Emotion': 'people',
  'People & Body': 'people',
  
  'Animals & Nature': 'nature',
  
  'Food & Drink': 'food',
  
  'Activities': 'activities',
  
  'Travel & Places': 'travel',
  
  'Objects': 'objects',
  
  'Symbols': 'symbols',
  
  'Flags': 'flags',
  
  // Component emojis (skin tones, hair styles) fold into people.
  'Component': 'people'
};

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
 * Hex codepoints joined by '-'. Covers multi-codepoint emoji (ZWJ sequences,
 * skin tones).
 */
function emojiToCodepoint(unicode) {
  const codepoints = [];
  for (const char of unicode) {
    const cp = char.codePointAt(0);
    if (cp !== undefined) {
      codepoints.push(cp.toString(16).toLowerCase());
    }
  }
  return codepoints.join('-');
}

function nameToShortcode(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // Remove special chars
    .replace(/\s+/g, '_')          // Replace spaces with underscores
    .replace(/-+/g, '_')           // Replace dashes with underscores
    .replace(/_+/g, '_')           // Collapse multiple underscores
    .replace(/^_|_$/g, '');        // Trim underscores
}

function main() {
  console.log('Building Unicode Emoji Data...\n');
  
  const twemojiFileMap = buildTwemojiFileMap();
  
  // unicode -> gemoji entry, for attaching GitHub aliases (`names`, `tags`)
  // as keywords on each emoji.
  const gemojiByUnicode = new Map();
  for (const g of gemoji) {
    gemojiByUnicode.set(g.emoji, g);
  }

  const emojis = [];
  const shortcodeToUnicode = {};
  const unicodeToShortcode = {};
  const unicodeToCodepoint = {};
  const categoryCounts = {};
  
  CATEGORIES.forEach(cat => {
    categoryCounts[cat.id] = 0;
  });
  
  const emojiEntries = Object.entries(unicodeEmoji);
  console.log(`Processing ${emojiEntries.length} emojis from unicode-emoji-json...\n`);
  
  for (const [unicode, data] of emojiEntries) {
    const category = CATEGORY_MAPPING[data.group];
    
    if (!category) {
      console.warn(`Unknown group: ${data.group} for emoji ${unicode}`);
      continue;
    }
    
    const shortcode = nameToShortcode(data.name);

    const gemojiEntry = gemojiByUnicode.get(unicode);
    const githubAliases = gemojiEntry?.names ?? [];
    const githubTags = gemojiEntry?.tags ?? [];

    const baseKeywords = [
      shortcode,
      ...data.name.toLowerCase().split(' '),
      ...githubAliases,
      ...githubTags,
    ].filter(Boolean);
    // Dedup case-insensitively; first spelling wins.
    const seenKw = new Set();
    const keywords = baseKeywords.filter(kw => {
      const key = kw.toLowerCase();
      if (seenKw.has(key)) return false;
      seenKw.add(key);
      return true;
    });

    // Shortcode collision: suffix with `_2`, `_3`, ... until unique.
    if (shortcodeToUnicode[shortcode]) {
      let uniqueShortcode = shortcode;
      let counter = 2;
      while (shortcodeToUnicode[uniqueShortcode]) {
        uniqueShortcode = `${shortcode}_${counter}`;
        counter++;
      }
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

    shortcodeToUnicode[shortcode] = unicode;
    unicodeToShortcode[unicode] = shortcode;
    unicodeToCodepoint[unicode] = codepoint;
    categoryCounts[category]++;
  }

  // GitHub/Discord-style aliases as extra shortcode lookup entries. Runs after
  // the main pass so canonical Unicode-derived shortcodes are never overwritten:
  // `grinning_face` keeps its mapping, `:grinning:` is added alongside.
  let aliasCount = 0;
  for (const entry of gemoji) {
    const names = entry.names ?? [];
    for (const alias of names) {
      if (!alias) continue;
      // Aliases must match `[a-zA-Z0-9_+-]+`, the inner shortcode regex.
      if (!/^[a-zA-Z0-9_+-]+$/.test(alias)) continue;
      if (!shortcodeToUnicode[alias]) {
        shortcodeToUnicode[alias] = entry.emoji;
        aliasCount++;
      }
    }
  }
  console.log(`Added ${aliasCount} GitHub/Discord-style shortcode aliases`);
  
  // Sort by category order; stable, so source order holds within a category.
  emojis.sort((a, b) => {
    const catA = CATEGORIES.find(c => c.id === a.category)?.order ?? 99;
    const catB = CATEGORIES.find(c => c.id === b.category)?.order ?? 99;
    return catA - catB;
  });
  
  const categoriesWithCount = CATEGORIES.map(cat => ({
    ...cat,
    count: categoryCounts[cat.id] || 0
  }));
  
  console.log('Category Summary:');
  categoriesWithCount.forEach(cat => {
    console.log(`   ${cat.icon} ${cat.name}: ${cat.count} emojis`);
  });
  
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
  
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  const outputPath = path.join(OUTPUT_DIR, 'unicode-emoji-data.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nGenerated: ${outputPath}`);
  console.log(`   Total emojis: ${emojis.length}`);
  
  // Lookups-only file; loaded on its own for faster startup.
  const lookupsPath = path.join(OUTPUT_DIR, 'unicode-emoji-lookups.json');
  fs.writeFileSync(lookupsPath, JSON.stringify({
    version: '15.1',
    shortcodeToUnicode,
    unicodeToShortcode,
    unicodeToCodepoint
  }, null, 2));
  console.log(`Generated: ${lookupsPath}`);
  
  // Twemoji file map; drives SVG path resolution at runtime.
  if (twemojiFileMap) {
    const twemojiMapPath = path.join(OUTPUT_DIR, 'twemoji-file-map.json');
    fs.writeFileSync(twemojiMapPath, JSON.stringify(twemojiFileMap, null, 2));
    console.log(`Generated: ${twemojiMapPath}`);
  }
  
  console.log('\nDone!');
}

main();

