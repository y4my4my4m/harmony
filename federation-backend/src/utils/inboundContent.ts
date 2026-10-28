import { normalizeInboundMentions } from './mentionParts.js';
import { withoutPollParts } from './polls.js';
import { stripIncomingMediaPaths } from './privateMedia.js';
import { normalizeInboundStickers } from './stickers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emojiName(emoji: Record<string, any>): string {
  const name = typeof emoji.name === 'string' ? emoji.name.replace(/:/g, '').trim() : '';
  return name || 'emoji';
}

/**
 * Emoji parts with the sending instance's emojis.id carry `remote:<name>` instead: that uuid
 * names no row here, or another emoji's. Other ids (IRIs, `remote:` forms) are kept.
 */
export function withRemoteEmojiIds(content: any[]): any[] {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    const emoji = part && typeof part === 'object' && part.type === 'emoji' ? part.emoji : null;
    if (!emoji || typeof emoji !== 'object' || typeof emoji.id !== 'string' || !UUID.test(emoji.id)) return part;
    return { ...part, emoji: { ...emoji, id: `remote:${emojiName(emoji)}` } };
  });
}

/**
 * Emoji parts of a remote channel message in the URL form the Discord bridge also writes: id
 * `remote:<name>`, the image url, the sender's domain, is_remote. Remote emoji uuids name no row
 * here.
 */
export function urlFormEmojis(content: any, domain: string): any {
  if (!Array.isArray(content)) return content;
  return content.map((item: any) => {
    if (!item || item.type !== 'emoji' || !item.emoji) return item;
    return {
      type: 'emoji',
      emoji: {
        id: `remote:${emojiName(item.emoji)}`,
        name: item.emoji.name || 'emoji',
        url: item.emoji.url,
        domain,
        is_remote: true,
      },
    };
  });
}

/**
 * Incoming `harmony:rawContent` as stored here: file parts lose `path` and poll parts are
 * dropped (both name rows of the sending instance only), mention locality is re-derived for
 * this instance, sticker parts are checked and marked with their instance, and emoji parts
 * lose the sending instance's row ids.
 */
export function inboundRawContent(content: any[], senderHost: string | null): any[] {
  return withRemoteEmojiIds(normalizeInboundStickers(
    normalizeInboundMentions(withoutPollParts(stripIncomingMediaPaths(content)), senderHost),
    senderHost,
  ));
}
