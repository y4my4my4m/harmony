import { normalizeInboundMentions } from './mentionParts.js';
import { withoutPollParts } from './polls.js';
import { stripIncomingMediaPaths } from './privateMedia.js';
import { normalizeInboundStickers } from './stickers.js';

/**
 * Incoming `harmony:rawContent` as stored here: file parts lose `path` and poll parts are
 * dropped (both name rows of the sending instance only), mention locality is re-derived for
 * this instance, and sticker parts are checked and marked with their instance.
 */
export function inboundRawContent(content: any[], senderHost: string | null): any[] {
  return normalizeInboundStickers(
    normalizeInboundMentions(withoutPollParts(stripIncomingMediaPaths(content)), senderHost),
    senderHost,
  );
}
