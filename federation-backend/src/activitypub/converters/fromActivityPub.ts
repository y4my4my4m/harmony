import { config } from '../../config/index.js';
import { decodeHtmlEntities, escapeHtml } from '../../utils/contentUtils.js';
import { anchorLinkLabel } from '../../utils/maskedLinks.js';
import { findHandles } from '../../utils/mentionGrammar.js';
import { parseFocalPoint } from '../../utils/focalPoint.js';
import { HARMONY_INSTANCE_ROLE, parseInstanceRole, type InstanceRole } from '../copyMirror.js';

interface MentionTagInfo {
  username: string;
  /** Handle host from the tag name, else the href host. */
  domain: string | null;
  hrefHost: string | null;
  href: string | null;
}

/**
 * Identity of a Mention tag. The name supplies the handle (`@user@host`);
 * the href supplies the actor and, when the name lacks one, the host and
 * user. Misskey hrefs carry an id (`/users/<id>`), so a named user wins.
 */
function mentionTagInfo(tag: any): MentionTagInfo | null {
  const name = typeof tag?.name === 'string' ? tag.name.replace(/^@+/, '') : '';
  const [nameUser, nameHost] = name.split('@');
  let username = nameUser || '';
  let domain: string | null = nameHost ? nameHost.toLowerCase() : null;
  const href = typeof tag?.href === 'string' ? tag.href : null;
  let hrefHost: string | null = null;
  if (href) {
    try {
      const url = new URL(href);
      hrefHost = url.hostname.toLowerCase();
      const path = url.pathname || '';
      // Mastodon/Pleroma: /users/<name>; GoToSocial/Misskey: /@<name>
      const hrefUser = path.match(/\/users\/([^/]+)\/?$/)?.[1] ?? path.match(/^\/@([^/]+)\/?$/)?.[1];
      if (!username && hrefUser) username = hrefUser;
      if (!domain) domain = hrefHost;
    } catch { /* href not a valid URL */ }
  }
  username = username.replace(/^@+/, '');
  if (!username) return null;
  return { username, domain, hrefHost, href };
}

/** An IRI given as a string, or as an object with an `id` or `href`. */
function iriOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object') {
    const v = value as { id?: unknown; href?: unknown };
    if (typeof v.id === 'string' && v.id) return v.id;
    if (typeof v.href === 'string' && v.href) return v.href;
  }
  return null;
}

/** Quoted object of a Note: FEP-044f `quote`, then quoteUrl, quoteUri and _misskey_quote. */
export function noteQuoteUrl(note: any): string | null {
  for (const key of ['quote', 'quoteUrl', 'quoteUri', '_misskey_quote']) {
    const iri = iriOf(note?.[key]);
    if (iri && /^https?:\/\//i.test(iri)) return iri;
  }
  return null;
}

/** Long-form object types stored as posts: blog posts (Article), Lemmy, Mbin and PieFed posts (Page), PeerTube videos (Video). */
const LONG_FORM_TYPES = new Set(['Article', 'Page', 'Video']);

/** Object types an inbox Create or a fetch stores as a post. Question is a poll. */
export function isPostObjectType(type: unknown): boolean {
  return type === 'Note' || type === 'Question' || (typeof type === 'string' && LONG_FORM_TYPES.has(type));
}

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;

/** A BCP 47 tag, primary subtag lowercased; null for anything else. */
function languageTag(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 35 || !LANGUAGE_TAG.test(value)) return null;
  const [primary, ...rest] = value.split('-');
  return [primary.toLowerCase(), ...rest].join('-');
}

/**
 * Language of an object: the first BCP 47 key of `contentMap`, else `language` as a tag or
 * as Lemmy's `{ identifier }`. `und` is no language.
 */
export function objectLanguage(object: any): string | null {
  const map = object?.contentMap;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const key of Object.keys(map)) {
      const tag = languageTag(key);
      if (tag && tag !== 'und') return tag;
    }
  }
  const declared = typeof object?.language === 'string' ? object.language : object?.language?.identifier;
  const tag = languageTag(declared);
  return tag && tag !== 'und' ? tag : null;
}

/** `content`, else the contentMap entry of the object's language, else its first non-empty entry. */
function contentOf(object: any): string {
  if (typeof object?.content === 'string' && object.content) return object.content;
  const map = object?.contentMap;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return '';
  const language = objectLanguage(object);
  const keyed = language ? Object.entries(map).find(([key]) => languageTag(key) === language)?.[1] : undefined;
  if (typeof keyed === 'string' && keyed) return keyed;
  const first = Object.values(map).find((value) => typeof value === 'string' && value);
  return typeof first === 'string' ? first : '';
}

/** Largest `icon` image of an object (PeerTube lists thumbnails by size); null without one. */
function largestIcon(object: any): any | null {
  const icons = (Array.isArray(object?.icon) ? object.icon : [object?.icon])
    .filter((icon: any) => icon && typeof icon === 'object' && attachmentUrl(icon));
  if (icons.length === 0) return null;
  return icons.reduce((best: any, icon: any) => (Number(icon.width) || 0) > (Number(best.width) || 0) ? icon : best);
}

/**
 * An object as the Note a post is built from. `content` falls back to `contentMap`. An
 * Article, Page or Video leads with its `name` as a paragraph; a Page's Link attachments
 * (a Lemmy link post) and a Video's page follow the body, and a Video's largest `icon` is
 * its image attachment, with the title as alt text. On those types `summary` is an excerpt,
 * kept as the content warning only with `sensitive: true`. `type` is kept. Objects of other
 * types are returned as given.
 */
export function asNoteObject(object: any): any {
  if (!object || typeof object !== 'object' || !isPostObjectType(object.type)) return object;
  const content = contentOf(object);
  if (!LONG_FORM_TYPES.has(object.type)) {
    return !content || content === object.content ? object : { ...object, content };
  }

  const blocks: string[] = [];
  if (typeof object.name === 'string' && object.name.trim()) blocks.push(`<p>${escapeHtml(object.name.trim())}</p>`);
  // PeerTube marks its description text/markdown; it is shown as text.
  const plain = object.mediaType === 'text/markdown' || object.mediaType === 'text/plain';
  if (content) blocks.push(`<div>${plain ? escapeHtml(content).replace(/\r?\n/g, '<br>') : content}</div>`);
  const links = new Set<string>();
  if (object.type === 'Page') {
    for (const item of attachmentList(object.attachment)) {
      if (item.type === 'Link' && typeof item.href === 'string' && /^https?:\/\//i.test(item.href)) links.add(item.href);
    }
  }
  if (object.type === 'Video') {
    const page = noteUrl(object);
    if (page) links.add(page);
  }
  for (const link of links) blocks.push(`<p>${escapeHtml(link)}</p>`);

  const attachment = attachmentList(object.attachment).filter((item) => item.type !== 'Link');
  const thumbnail = object.type === 'Video' ? largestIcon(object) : null;
  if (thumbnail) {
    attachment.push({
      type: 'Image',
      mediaType: typeof thumbnail.mediaType === 'string' ? thumbnail.mediaType : 'image/jpeg',
      url: attachmentUrl(thumbnail),
      name: typeof object.name === 'string' ? object.name.trim() : undefined,
      width: thumbnail.width,
      height: thumbnail.height,
    });
  }

  const note = { ...object, content: blocks.join(''), attachment };
  if (object.sensitive !== true) delete note.summary;
  return note;
}

/** Human page of a Note: `url` as a string, a Link's href, or the first text/html entry of an array. */
export function noteUrl(note: any): string | null {
  const url = note?.url;
  const candidates = Array.isArray(url) ? url : [url];
  const html = candidates.find((u: any) => u && typeof u === 'object' && u.mediaType === 'text/html') ?? candidates[0];
  const iri = iriOf(html);
  return iri && /^https?:\/\//i.test(iri) ? iri : null;
}

/** FEP-7888 `context` of a Note, as a reference or an embedded collection's id; http(s) only. */
export function noteContext(note: any): string | null {
  const iri = iriOf(note?.context);
  return iri && /^https?:\/\//i.test(iri) ? iri : null;
}

/**
 * HTML without its FEP-044f fallback element: the first <p> or <span> of class quote-inline
 * and everything nested in it. Applied only to a Note that carries a quote.
 */
export function stripQuoteInline(html: string): string {
  const open = /<(p|span)\b[^>]*\bclass\s*=\s*["'][^"']*\bquote-inline\b[^"']*["'][^>]*>/i.exec(html);
  if (!open) return html;
  const tag = open[1].toLowerCase();
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(0, open.index) + html.slice(m.index + m[0].length);
  }
  return html;
}

/**
 * Convert ActivityPub Note to internal MessagePart[] format
 * Uses the same logic as the SQL convert_ap_to_jsonb function
 */
export function noteToContent(note: any): any[] {
  const parts: any[] = [];

  const html = typeof note.content === 'string' && noteQuoteUrl(note) ? stripQuoteInline(note.content) : note.content;

  // Media-only Notes carry an empty content.
  if (!html) {
    addAttachments(parts, note.attachment);
    return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
  }
  
  // Step 0: labelled anchors (`<a href=X>text</a>` whose text is not X) become placeholders the
  // cleaning keeps; splitTextWithUrls turns them into url parts with a label.
  const links: LabelledLink[] = [];
  const withLinks = labelledAnchorsToPlaceholders(html, links);

  // Step 1: Clean HTML to get plain text
  let cleanText: string = withLinks;
  cleanText = cleanText.replace(/<br\s*\/?>/gi, '\n');
  // Block-level closing tags: <p>, <blockquote>, <h1>-<h6> imply paragraph breaks (double newline)
  cleanText = cleanText.replace(/<\/(?:p|blockquote|h[1-6])>/gi, '\n\n');
  // <div>, <li> closing tags imply simple line breaks
  cleanText = cleanText.replace(/<\/(?:div|li)>/gi, '\n');
  cleanText = cleanText.replace(/<(?:p|div|li|blockquote|h[1-6])(?:\s[^>]*)?>/gi, '');
  // Remove inline tags WITHOUT adding spaces so @<span>user</span> → @user (not "@ user")
  cleanText = cleanText.replace(/<\/?(?:span|a|strong|b|em|i|u|s|del|code|sub|sup|mark|small|big|abbr)[^>]*>/gi, '');
  cleanText = cleanText.replace(/<[^>]*>/g, ' ');
  cleanText = cleanText.replace(/[ \t]+/g, ' ');
  cleanText = cleanText.replace(/&nbsp;/g, ' ');
  cleanText = cleanText.replace(/&amp;/g, '&');
  cleanText = cleanText.replace(/&lt;/g, '<');
  cleanText = cleanText.replace(/&gt;/g, '>');
  cleanText = cleanText.replace(/&quot;/g, '"');
  cleanText = cleanText.replace(/&apos;/g, "'");
  cleanText = cleanText.replace(/&#x([\da-fA-F]+);/g, (match, hex) => {
    const cp = parseInt(hex, 16);
    return cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : match;
  });
  cleanText = cleanText.replace(/&#(\d+);/g, (match, n) => {
    const cp = parseInt(n, 10);
    return cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : match;
  });
  // Collapse horizontal whitespace but preserve newlines from <br>/<p> replacements
  cleanText = cleanText.replace(/[^\S\n]+/g, ' ');
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
  cleanText = cleanText.trim();
  
  // Build combined tags array (includes both standard AP tags and Misskey-style emojis)
  const allTags = note.tag && Array.isArray(note.tag) ? [...note.tag] : [];
  
  // Handle Misskey-style emojis object: { emojiName: url, ... }
  // This is common in outbox items where emoji definitions aren't in the tag array
  if (note.emojis && typeof note.emojis === 'object' && !Array.isArray(note.emojis)) {
    for (const [name, url] of Object.entries(note.emojis)) {
      // Only add if not already in tags
      const alreadyInTags = allTags.some(t => 
        t.type === 'Emoji' && t.name?.replace(/:/g, '') === name
      );
      if (!alreadyInTags && url) {
        allTags.push({
          type: 'Emoji',
          name: `:${name}:`,
          icon: { url }
        });
      }
    }
  }
  
  // If no tags, parse URLs from the text and return
  if (allTags.length === 0) {
    if (cleanText) {
      splitTextWithUrls(parts, cleanText, links);
    }
    
    // Still check for attachments
    addAttachments(parts, note.attachment);
    return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
  }
  
  // Step 2: Find positions of all tags in the clean text. A Mention tag
  // claims the first unclaimed handle token (shared grammar) naming the same
  // user, written either `@user` or `@user@host` with the tag's host or href
  // host. Tags with no such token produce no part.
  const tagPositions: Array<{position: number, length: number, tag: any, text: string, mention?: MentionTagInfo}> = [];
  const handleTokens = findHandles(cleanText);
  const claimed = new Set<number>();

  for (const tag of allTags) {
    let searchText = '';
    let position = -1;
    
    if (tag.type === 'Emoji') {
      let emojiName = tag.name || '';
      if (emojiName.startsWith(':')) emojiName = emojiName.slice(1);
      if (emojiName.endsWith(':')) emojiName = emojiName.slice(0, -1);
      searchText = `:${emojiName}:`;
      position = cleanText.indexOf(searchText);
    }
    else if (tag.type === 'Mention') {
      const info = mentionTagInfo(tag);
      if (!info) continue;
      const user = info.username.toLowerCase();
      const idx = handleTokens.findIndex((h, i) =>
        !claimed.has(i) &&
        h.username.toLowerCase() === user &&
        (!h.domain || h.domain === info.domain || h.domain === info.hrefHost));
      if (idx === -1) continue;
      claimed.add(idx);
      const token = handleTokens[idx];
      tagPositions.push({ position: token.start, length: token.end - token.start, tag, text: token.raw, mention: info });
      continue;
    }
    else if (tag.type === 'Hashtag') {
      const hashtagName = tag.name?.startsWith('#') ? tag.name : `#${tag.name}`;
      searchText = hashtagName;
      position = cleanText.indexOf(searchText);
    }
    
    // An emoji or hashtag tag covers every use of its name, not only the first. A hashtag
    // ends where a word does: #cat is not the start of #catfood.
    while (position >= 0 && searchText) {
      const after = cleanText[position + searchText.length] ?? '';
      if (tag.type !== 'Hashtag' || !/[\p{L}\p{N}_]/u.test(after)) {
        tagPositions.push({ position, length: searchText.length, tag, text: searchText });
      }
      position = cleanText.indexOf(searchText, position + searchText.length);
    }
  }
  
  // Step 3: Sort tags by position
  tagPositions.sort((a, b) => a.position - b.position);
  
  // Step 4: Build MessageParts in order
  let currentIndex = 0;
  
  for (const tagPos of tagPositions) {
    // Overlapping tags: the earlier one owns the span.
    if (tagPos.position < currentIndex) continue;

    // Add text before this tag (with URL detection)
    if (tagPos.position > currentIndex) {
      const textBefore = cleanText.substring(currentIndex, tagPos.position);
      if (textBefore.trim()) {
        splitTextWithUrls(parts, textBefore, links);
      }
    }
    
    if (tagPos.tag.type === 'Emoji') {
      let emojiName = tagPos.tag.name || '';
      if (emojiName.startsWith(':')) emojiName = emojiName.slice(1);
      if (emojiName.endsWith(':')) emojiName = emojiName.slice(0, -1);
      
      parts.push({
        type: 'emoji',
        emoji: {
          id: tagPos.tag.id || `remote-${emojiName}`,
          name: emojiName,
          url: tagPos.tag.icon?.url || tagPos.tag.icon,
          server_id: 'remote'
        }
      });
    }
    else if (tagPos.tag.type === 'Mention' && tagPos.mention) {
      const { username, domain, href } = tagPos.mention;
      const currentDomain = config.INSTANCE_DOMAIN;
      const isLocal = !domain || domain === String(currentDomain).toLowerCase();

      parts.push({
        type: 'mention',
        username,
        domain: domain || currentDomain,
        isLocal,
        userId: href || `remote-${username}`,
        displayName: username
      });
    }
    else if (tagPos.tag.type === 'Hashtag') {
      let tagName = tagPos.tag.name || '';
      if (tagName.startsWith('#')) tagName = tagName.slice(1);
      
      parts.push({
        type: 'hashtag',
        name: tagName
      });
    }
    
    currentIndex = tagPos.position + tagPos.length;
  }
  
  // Add remaining text after all tags (with URL detection)
  if (currentIndex < cleanText.length) {
    const remaining = cleanText.substring(currentIndex);
    if (remaining.trim()) {
      splitTextWithUrls(parts, remaining, links);
    }
  }
  
  addAttachments(parts, note.attachment);
  
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

interface LabelledLink {
  url: string;
  label: string;
}

// U+E010 <index> U+E011: private-use code points no cleaning step touches.
const LINK_PLACEHOLDER = /\uE010(\d+)\uE011/g;
const ANCHOR = /<a\s([^>]*)>([\s\S]*?)<\/a>(<span class="invisible">[^<]*<\/span>)?/gi;

/**
 * Replaces each anchor whose text is a label (utils/maskedLinks anchorLinkLabel) with a
 * placeholder indexing `links`. Mentions, hashtags and anchors showing their own URL are left
 * for the cleaning. The `<span class="invisible"> (URL)</span>` this version sends after a
 * labelled anchor goes with it.
 */
function labelledAnchorsToPlaceholders(html: string, links: LabelledLink[]): string {
  return html.replace(ANCHOR, (whole: string, attrs: string, inner: string, invisible?: string) => {
    if (/\bclass\s*=\s*["'][^"']*\b(?:mention|hashtag|u-url)\b/i.test(attrs)) return whole;
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const href = decodeHtmlEntities(hrefMatch?.[1] ?? hrefMatch?.[2] ?? '').trim();
    if (!/^https?:\/\//i.test(href)) return whole;
    const text = decodeHtmlEntities(inner.replace(/<[^>]*>/g, ''));
    // "@user" and "#tag" text is a mention or hashtag some servers send without a class.
    if (/^\s*[@#]/.test(text)) return whole;
    const label = anchorLinkLabel(text, href);
    if (!label) return whole;
    links.push({ url: href, label });
    const shown = invisible ? decodeHtmlEntities(invisible.replace(/<[^>]*>/g, '')) : '';
    const tail = invisible && !shown.includes(href) ? invisible : '';
    return `\uE010${links.length - 1}\uE011${tail}`;
  });
}

/**
 * Split text on URLs, emitting alternating text and url parts.
 * Bare https?:// URLs found in the cleaned plain-text become clickable
 * `{ type: 'url', url, preview: true }` parts; link placeholders become url
 * parts with their label.
 */
function splitTextWithUrls(parts: any[], text: string, links: LabelledLink[] = []): void {
  if (links.length > 0 && text.includes('\uE010')) {
    let last = 0;
    LINK_PLACEHOLDER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_PLACEHOLDER.exec(text)) !== null) {
      const link = links[Number(m[1])];
      if (!link) continue;
      if (m.index > last) splitTextWithUrls(parts, text.slice(last, m.index));
      parts.push({ type: 'url', url: link.url, preview: true, label: link.label });
      last = m.index + m[0].length;
    }
    if (last < text.length) splitTextWithUrls(parts, text.slice(last));
    return;
  }

  const urlRegex = /\bhttps?:\/\/\S+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.substring(lastIndex, match.index);
      if (before.trim()) parts.push({ type: 'text', text: before });
    }

    let url = match[0];
    url = url.replace(/[.,;:!?)>\]]+$/, '');

    parts.push({ type: 'url', url, preview: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const remaining = text.substring(lastIndex);
    if (remaining.trim()) parts.push({ type: 'text', text: remaining });
  }
}

/** ActivityStreams `attachment`: one object or an array of them. */
function attachmentList(value: unknown): any[] {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  return value && typeof value === 'object' ? [value] : [];
}

/** http(s) URL of an attachment: `url` as a string, a Link (`href`) or an array of either. */
function attachmentUrl(attachment: any): string | null {
  const candidates = Array.isArray(attachment?.url) ? attachment.url : [attachment?.url];
  for (const candidate of candidates) {
    const url = typeof candidate === 'string' ? candidate : candidate?.href;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function mediaFileType(mediaType: string, url: string): 'image' | 'video' | 'audio' | 'file' {
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('video/')) return 'video';
  if (mediaType.startsWith('audio/')) return 'audio';
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogv', 'quicktime'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(ext)) return 'audio';
  return 'file';
}

/**
 * Helper: Add media attachments to parts array
 */
function addAttachments(parts: any[], attachments: any): void {
  for (const attachment of attachmentList(attachments)) {
    const url = attachmentUrl(attachment);
    if (!url) continue;
    const mediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : '';

    const filePart: any = {
      type: 'file',
      url,
      fileType: mediaFileType(mediaType, url),
      mimeType: mediaType, // Store the full MIME type
      fileName: attachment.name,
      altText: attachment.name, // Alt text for accessibility
    };

    if (attachment.width) filePart.width = attachment.width;
    if (attachment.height) filePart.height = attachment.height;

    if (attachment.blurhash) filePart.blurhash = attachment.blurhash;

    const focalPoint = parseFocalPoint(attachment.focalPoint);
    if (focalPoint) filePart.focalPoint = focalPoint;

    parts.push(filePart);
  }
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * `posts.media_attachments` rows of an object's attachments, in the composer row shape
 * `{ type, mediaType, url, description, width, height, blurhash, focalPoint }`. The AP
 * `name` of an attachment is its alt text and is stored as `description`; `name` on a
 * composer row is the upload's file name. The same attachments are the file parts of
 * noteToContent.
 */
export function extractMediaAttachments(attachments: unknown): any[] {
  const rows: any[] = [];
  for (const attachment of attachmentList(attachments)) {
    const url = attachmentUrl(attachment);
    if (!url) continue;
    const alt = typeof attachment.name === 'string' ? attachment.name.trim() : '';
    rows.push({
      type: typeof attachment.type === 'string' && attachment.type ? attachment.type : 'Document',
      mediaType: typeof attachment.mediaType === 'string' && attachment.mediaType
        ? attachment.mediaType
        : 'application/octet-stream',
      url,
      description: alt || null,
      width: positiveNumber(attachment.width),
      height: positiveNumber(attachment.height),
      blurhash: typeof attachment.blurhash === 'string' ? attachment.blurhash : null,
      focalPoint: parseFocalPoint(attachment.focalPoint),
    });
  }
  return rows;
}

/** profiles.also_known_as holds at most this many URIs (profiles_also_known_as_length). */
export const MAX_ACTOR_ALIASES = 20;

/** Absolute http(s) URI of a reference given as a string or an object with an id. */
function referenceUri(value: unknown): string | null {
  const id = typeof value === 'string' ? value : (value as any)?.id;
  if (typeof id !== 'string' || id.length > 2048) return null;
  try {
    const url = new URL(id);
    return url.protocol === 'https:' || url.protocol === 'http:' ? id : null;
  } catch {
    return null;
  }
}

/** ActivityPub alsoKnownAs (one reference or an array) as distinct URIs, first MAX_ACTOR_ALIASES kept. */
export function parseAlsoKnownAs(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const uris: string[] = [];
  for (const item of items) {
    const uri = referenceUri(item);
    if (uri && !uris.includes(uri)) uris.push(uri);
    if (uris.length === MAX_ACTOR_ALIASES) break;
  }
  return uris;
}

/** ActivityPub movedTo as a URI; null when absent or not an http(s) reference. */
export function parseMovedTo(value: unknown): string | null {
  return referenceUri(Array.isArray(value) ? value[0] : value);
}

/**
 * Extract user profile data from ActivityPub Actor
 */
export function actorToProfile(actor: any): {
  username: string;
  domain: string;
  display_name?: string;
  bio?: string;
  avatar?: string;
  banner?: string;
  color?: string;
  custom_status?: any;
  public_key?: string;
  federated_id: string;
  inbox_url: string;
  outbox_url?: string;
  followers_url?: string;
  following_url?: string;
  profile_fields?: Array<{ name: string; value: string }>;
  federation_discoverable?: boolean;
  manually_approves_followers?: boolean;
  bio_emojis?: Array<{ name: string; url: string }>;
  display_name_emojis?: Array<{ name: string; url: string }>;
  also_known_as: string[];
  moved_to_uri: string | null;
  instance_role: InstanceRole | null;
} {
  const actorUrl = new URL(actor.id);
  const domain = actorUrl.hostname;
  const username = actor.preferredUsername || actorUrl.pathname.split('/').pop() || 'unknown';

  const profile: any = {
    username,
    domain,
    federated_id: actor.id,
    inbox_url: actor.inbox,
    outbox_url: actor.outbox,
    followers_url: actor.followers,
    following_url: actor.following,
    is_local: false,
    also_known_as: parseAlsoKnownAs(actor.alsoKnownAs).filter((uri) => uri !== actor.id),
    moved_to_uri: parseMovedTo(actor.movedTo),
    // Staff of the actor's own instance: the document comes from its own URL or its own Update.
    instance_role: parseInstanceRole(actor[HARMONY_INSTANCE_ROLE]),
  };
  if (profile.moved_to_uri === actor.id) profile.moved_to_uri = null;

  // Length clamps mirror the DB sanitize_profile_text() guard. The DB trigger
  // is authoritative (it also strips bidi/zero-width/control chars), but
  // clamping here avoids shipping oversized payloads from hostile remotes.
  if (actor.name) {
    profile.display_name = String(actor.name).slice(0, 80);
  }

  if (actor.summary) {
    let bio = actor.summary;
    bio = bio.replace(/<br\s*\/?>/gi, '\n');
    bio = bio.replace(/<\/p>\s*<p>/gi, '\n\n');
    bio = bio.replace(/<[^>]*>/g, ' ');
    bio = bio.replace(/[ \t]+/g, ' ');
    bio = decodeHtmlEntities(bio);
    profile.bio = bio.trim().slice(0, 500);
  }

  if (typeof actor.icon === 'string') {
    profile.avatar = actor.icon;
  } else if (actor.icon?.url) {
    profile.avatar = actor.icon.url;
  }

  if (typeof actor.image === 'string') {
    profile.banner = actor.image;
  } else if (actor.image?.url) {
    profile.banner = actor.image.url;
  }

  // Harmony extension: profile color
  if (actor['harmony:profileColor']) {
    profile.color = actor['harmony:profileColor'];
  }

  // Harmony extension: custom status (Discord-style status)
  if (actor['harmony:customStatus']) {
    profile.custom_status = actor['harmony:customStatus'];
  }

  if (actor.publicKey?.publicKeyPem) {
    profile.public_key = actor.publicKey.publicKeyPem;
  }

  if (actor.attachment && Array.isArray(actor.attachment)) {
    const profileFields = actor.attachment
      .filter((att: any) => att.type === 'PropertyValue')
      .slice(0, 4)
      .map((att: any) => ({
        name: String(att.name || '').slice(0, 255),
        value: String(att.value || '').slice(0, 255),
      }));
    
    if (profileFields.length > 0) {
      profile.profile_fields = profileFields;
    }
  }

  if (actor.discoverable !== undefined) {
    profile.federation_discoverable = actor.discoverable;
  }

  if (actor.manuallyApprovesFollowers !== undefined) {
    profile.manually_approves_followers = actor.manuallyApprovesFollowers;
  }

  const allEmojis: Array<{ name: string; url: string }> = [];

  if (actor.tag && Array.isArray(actor.tag)) {
    actor.tag
      .filter((tag: any) => tag.type === 'Emoji')
      .forEach((tag: any) => {
        const name = tag.name?.replace(/:/g, '') || '';
        const url = tag.icon?.url || tag.icon;
        if (name && url) allEmojis.push({ name, url });
      });
  }

  // Also handle Misskey-style emojis object on the actor
  if (actor.emojis && typeof actor.emojis === 'object' && !Array.isArray(actor.emojis)) {
    for (const [name, url] of Object.entries(actor.emojis)) {
      if (name && url && !allEmojis.some(e => e.name === name)) {
        allEmojis.push({ name, url: url as string });
      }
    }
  }

  if (allEmojis.length > 0) {
    const displayName = actor.name || '';
    const bioText = actor.summary || '';
    const displayNameEmojis: typeof allEmojis = [];
    const bioEmojis: typeof allEmojis = [];

    for (const emoji of allEmojis) {
      const shortcode = `:${emoji.name}:`;
      const inDisplayName = displayName.includes(shortcode);
      const inBio = bioText.includes(shortcode) || bioText.includes(emoji.name);

      if (inDisplayName) displayNameEmojis.push(emoji);
      if (inBio) bioEmojis.push(emoji);
      // If not found in either, still put in bio_emojis as fallback
      if (!inDisplayName && !inBio) bioEmojis.push(emoji);
    }

    if (bioEmojis.length > 0) {
      profile.bio_emojis = bioEmojis;
    }
    if (displayNameEmojis.length > 0) {
      profile.display_name_emojis = displayNameEmojis;
    }
  }

  return profile;
}

/**
 * Extract data from Follow activity
 */
export function extractFollowData(activity: any): {
  followerUrl: string;
  followingUrl: string;
  activityId: string;
} {
  return {
    followerUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    followingUrl: typeof activity.object === 'string' ? activity.object : activity.object.id,
    activityId: activity.id,
  };
}

/**
 * Extract data from Like activity
 */
export function extractLikeData(activity: any): {
  actorUrl: string;
  objectUrl: string;
  emoji?: string;
  emojiUrl?: string;
  emojiName?: string;
} {
  const data: any = {
    actorUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    objectUrl: typeof activity.object === 'string' ? activity.object : activity.object.id,
  };

  // Misskey-style reaction
  if (activity._misskey_reaction || activity.content) {
    data.emoji = activity._misskey_reaction || activity.content;
    data.emojiName = data.emoji;
  }
  
  if (Array.isArray(activity.tag)) {
    const emojiTag = activity.tag.find((t: any) => t.type === 'Emoji');
    if (emojiTag) {
      data.emojiUrl = emojiTag.icon?.url;
      data.emojiName = emojiTag.name || data.emoji;
    }
  }

  return data;
}

/**
 * Extract data from Announce activity (reblog/boost)
 */
export function extractAnnounceData(activity: any): {
  actorUrl: string;
  objectUrl: string;
  published?: string;
} {
  return {
    actorUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    objectUrl: typeof activity.object === 'string' ? activity.object : activity.object.id,
    published: activity.published,
  };
}

/**
 * Extract data from Delete activity
 */
export function extractDeleteData(activity: any): {
  actorUrl: string;
  objectUrl: string;
} {
  return {
    actorUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    objectUrl: typeof activity.object === 'string' ? activity.object : activity.object.id,
  };
}

/**
 * Extract data from Update activity
 */
export function extractUpdateData(activity: any): {
  actorUrl: string;
  object: any;
} {
  return {
    actorUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    object: activity.object,
  };
}

/**
 * Normalize ActivityPub object (handle both URL strings and embedded objects)
 */
export function normalizeObject(obj: any): any {
  if (typeof obj === 'string') {
    return { id: obj };
  }
  return obj;
}

/**
 * Normalize actor (handle both URL strings and embedded actor objects)
 */
export function normalizeActor(actor: any): string {
  if (typeof actor === 'string') {
    return actor;
  }
  return actor.id;
}

