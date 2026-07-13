// Single source of truth for emoji category definitions, used across all emoji pickers.
export interface EmojiCategory {
  id: string;
  name: string;
  icon: string;
  order: number;
}

// Order matches the Unicode standard and Discord's emoji picker.
export const EMOJI_CATEGORIES: EmojiCategory[] = [
  { id: 'people', name: 'People', icon: '😀', order: 0 },
  { id: 'nature', name: 'Nature', icon: '🐱', order: 1 },
  { id: 'food', name: 'Food', icon: '🍔', order: 2 },
  { id: 'activities', name: 'Activities', icon: '⚽', order: 3 },
  { id: 'travel', name: 'Travel', icon: '🚗', order: 4 },
  { id: 'objects', name: 'Objects', icon: '💡', order: 5 },
  { id: 'symbols', name: 'Symbols', icon: '❤️', order: 6 },
  { id: 'flags', name: 'Flags', icon: '🏳️', order: 7 }
] as const;

export const CATEGORY_ORDER = ['people', 'nature', 'food', 'activities', 'travel', 'objects', 'symbols', 'flags'] as const;

export type CategoryId = typeof CATEGORY_ORDER[number];

export function getCategoryById(id: string): EmojiCategory | undefined {
  return EMOJI_CATEGORIES.find(cat => cat.id === id);
}

export function getCategoryIcon(id: string): string {
  return getCategoryById(id)?.icon ?? '📦';
}

export function sortCategoriesByOrder<T extends { id?: string; category?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const catA = a.id || a.category || '';
    const catB = b.id || b.category || '';
    const orderA = CATEGORY_ORDER.indexOf(catA as CategoryId);
    const orderB = CATEGORY_ORDER.indexOf(catB as CategoryId);
    return (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB);
  });
}

export const QUICK_REACTION_EMOJIS = [
  { unicode: '👍', shortcode: 'thumbs_up', name: 'thumbs up' },
  { unicode: '❤️', shortcode: 'heart', name: 'red heart' },
  { unicode: '😂', shortcode: 'joy', name: 'face with tears of joy' },
  { unicode: '😮', shortcode: 'open_mouth', name: 'face with open mouth' },
  { unicode: '😢', shortcode: 'cry', name: 'crying face' },
  { unicode: '😡', shortcode: 'rage', name: 'pouting face' },
  { unicode: '🎉', shortcode: 'tada', name: 'party popper' },
  { unicode: '🔥', shortcode: 'fire', name: 'fire' }
] as const;

/**
 * Emoji pack identifier.
 *
 * Built-in packs are 'twemoji' (default) and 'native' (system Unicode).
 * Instance operators may register additional packs at runtime via
 * `emojiPackService.registerEmojiPack(...)`, in which case `EmojiPack`
 * carries the operator's chosen id, so the underlying type is `string`.
 *
 * The `KNOWN_EMOJI_PACKS` constant below lists the built-in ids for
 * IntelliSense and documentation purposes.
 */
export type EmojiPack = string;

// Built-in ids only; custom packs registered by an instance operator are not listed here.
export const KNOWN_EMOJI_PACKS = ['twemoji', 'native'] as const;
export type KnownEmojiPack = (typeof KNOWN_EMOJI_PACKS)[number];

export const DEFAULT_EMOJI_PACK: KnownEmojiPack = 'twemoji';

export const TWEMOJI_BASE_URL = '/assets/emojis/twemoji';

export function getTwemojiUrl(codepoint: string): string {
  return `${TWEMOJI_BASE_URL}/${codepoint}.svg`;
}

