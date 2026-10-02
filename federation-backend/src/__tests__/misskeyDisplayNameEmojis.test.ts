import { describe, it, expect } from 'vitest';
import { misskeyDisplayNameEmojis } from '../utils/misskeyEmojis.js';

describe('misskeyDisplayNameEmojis', () => {
  it('serves local shortcodes from the queried instance', () => {
    expect(misskeyDisplayNameEmojis({ name: 'ますくど:seinen_comic::seizin_muke:', host: null, emojis: {} }, 'misskey.io'))
      .toEqual([
        { name: 'seinen_comic', url: 'https://misskey.io/emoji/seinen_comic.webp' },
        { name: 'seizin_muke', url: 'https://misskey.io/emoji/seizin_muke.webp' },
      ]);
  });

  it('keeps URLs Misskey lists and proxies the rest through the user host', () => {
    expect(misskeyDisplayNameEmojis(
      { name: ':a: :b:', host: 'other.example', emojis: { a: 'https://cdn.example/a.png' } },
      'misskey.io',
    )).toEqual([
      { name: 'a', url: 'https://cdn.example/a.png' },
      { name: 'b', url: 'https://misskey.io/emoji/b%40other.example.webp' },
    ]);
  });

  it('ignores non-https map entries and names without shortcodes', () => {
    expect(misskeyDisplayNameEmojis({ name: 'plain', emojis: { x: 'javascript:alert(1)' } }, 'misskey.io')).toEqual([]);
    expect(misskeyDisplayNameEmojis(null, 'misskey.io')).toEqual([]);
  });
});
