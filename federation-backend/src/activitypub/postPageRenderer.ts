/**
 * The public page of a post and the post card the profile page lists: text with custom emoji,
 * mentions and links, media with alt text and focal point, the content warning collapsed,
 * poll results, the quoted post, counts. OpenGraph and Twitter tags give link previews.
 *
 * Served at /@<username>/<post id> and as the HTML of /posts/<post id> (publicPages/routes.ts).
 * ActivityPub clients receive JSON at both (OutboxHandler).
 */

import config from '../config/index.js';
import { stripTrackingParameters } from '../utils/urlTrackerStripper.js';
import { escapeHtml, originalStorageUrl, resolveStorageUrl } from '../utils/html.js';
import { plainDisplayName } from '../utils/plainDisplayName.js';
import { storedFocalPoint } from '../utils/focalPoint.js';
import {
  absoluteUrl,
  formatCount,
  icon,
  joinCard,
  pageContext,
  pageInstance,
  renderShell,
  timeHtml,
  type PageContext,
} from '../publicPages/layout.js';
import { fillHtml, fillText } from '../publicPages/strings.js';

function stripHtml(html: string): string {
  return String(html ?? '').replace(/<[^>]*>/g, '').trim();
}

/**
 * URL schemes safe to embed in `href` / `src` attributes inside the
 * server-rendered post HTML. Everything else (notably `javascript:` and
 * `data:`) is rejected by `safeAttrUrl` below. Mirrors the frontend's
 * `sanitizeUrl` allowlist in `src/utils/sanitize.ts`.
 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/**
 * Return an attribute-safe absolute URL, or `''` if the URL uses an
 * unsafe scheme. Strips ASCII control characters first - browsers ignore
 * tabs/newlines inside URL schemes, which is a well-known XSS bypass
 * (`java\tscript:`).
 *
 * The returned value still needs to be passed through `escapeHtml` when
 * inlined into an HTML attribute. Pattern:
 *   `<a href="${escapeHtml(safeAttrUrl(url))}">`
 */
function safeAttrUrl(url: string | null | undefined): string {
  if (url == null) return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = String(url).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return '';
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!schemeMatch) {
    // Scheme-less: relative path / protocol-relative / fragment. Allowed.
    return cleaned;
  }
  const scheme = schemeMatch[1].toLowerCase() + ':';
  if (!SAFE_URL_SCHEMES.has(scheme)) return '';
  return cleaned;
}

/** An http(s) URL for `src` / `href`; '' for anything else, relative paths included. */
function safeHttpUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const safe = safeAttrUrl(url);
  return /^https?:\/\//i.test(safe) ? safe : '';
}

/**
 * Hex color sanity check used when rendering inline `style="color: ..."`
 * for role mentions. The role color is attacker-influenceable (federated
 * payload), so we reject anything that isn't a short or long hex literal
 * to keep CSS injection (`red; background: url(x)`) out of the page.
 */
const SAFE_HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

function isLocalDomain(domain: unknown): boolean {
  return !domain || String(domain).toLowerCase() === String(config.INSTANCE_DOMAIN).toLowerCase();
}

function extractPlainText(content: any): string {
  if (typeof content === 'string') return stripHtml(content);
  if (!Array.isArray(content)) return '';

  return content
    .map((item: any) => {
      if (item.type === 'text') return item.text || '';
      if (item.type === 'mention') {
        const domain = item.domain || config.INSTANCE_DOMAIN;
        return item.isLocal ? `@${item.username}` : `@${item.username}@${domain}`;
      }
      if (item.type === 'hashtag') return `#${item.name}`;
      if (item.type === 'link') return item.text || item.url || '';
      if (item.type === 'url') {
        const url = typeof item.url === 'string' ? item.url : '';
        return url ? stripTrackingParameters(url) : '';
      }
      if (item.type === 'embed') {
        return typeof item.url === 'string' ? item.url : '';
      }
      if (item.type === 'emoji') {
        const name = item.emoji?.name ? String(item.emoji.name) : '';
        return name ? `:${name}:` : '';
      }
      if (item.type === 'role_mention') {
        const roleName = item.roleName ? String(item.roleName) : '';
        return roleName ? `@${roleName}` : '';
      }
      // `file` (attachments are surfaced via the image grid, non-image files
      // would clutter the OG description) and `system` (membership events
      // aren't real post content) intentionally contribute nothing here.
      return '';
    })
    .join('')
    .trim();
}

/** Profile URL of a mention: the public page of a local account, the guessed actor URL elsewhere. */
function mentionHref(item: any): string {
  const username = String(item.username || 'unknown');
  if (item.isLocal === true || isLocalDomain(item.domain)) {
    return `https://${config.INSTANCE_DOMAIN}/@${encodeURIComponent(username)}`;
  }
  return `https://${item.domain}/users/${username}`;
}

/** `galleryUrls`: file parts shown in the media grid, left out of the text. */
function extractContentHtml(content: any, galleryUrls: Set<string> = new Set()): string {
  // Defensive: the DB constraint `posts_content_is_array` should make
  // this path unreachable, but if a string ever slipped through (e.g.
  // an early migration / federation import) we MUST escape it before
  // inlining into the post page - returning it raw would let a stored
  // `<style>` / `<img onerror>` etc. execute when crawlers / browsers
  // hit `/posts/:id`. Escape and turn newlines into `<br>` so the
  // shape matches a single text part.
  if (typeof content === 'string') {
    return escapeHtml(content).replace(/\n/g, '<br>');
  }
  if (!Array.isArray(content)) return '';

  return content
    .map((item: any) => {
      if (item.type === 'text') {
        let text = escapeHtml(item.text || '');
        text = text.replace(/\n/g, '<br>');
        return text;
      }
      if (item.type === 'mention') {
        // `username` / `domain` here come from a (possibly federated)
        // MessagePart, so we MUST escape both before splicing them into
        // the URL string AND into the visible label.
        const domain = item.domain || config.INSTANCE_DOMAIN;
        const username = item.username || 'unknown';
        const href = safeAttrUrl(mentionHref(item));
        const display = item.isLocal ? `@${username}` : `@${username}@${domain}`;
        return `<a href="${escapeHtml(href)}" class="mention">${escapeHtml(display)}</a>`;
      }
      if (item.type === 'hashtag') {
        return `<span class="hashtag">#${escapeHtml(item.name)}</span>`;
      }
      if (item.type === 'link') {
        // Scheme-validate the URL before inlining as `href` - a federated
        // payload could send `{ type: 'link', url: 'javascript:alert(1)' }`
        // and the link would execute on click otherwise.
        const safeUrl = safeAttrUrl(item.url);
        const label = item.text || item.url || 'link';
        if (!safeUrl) {
          // Render as inert text so the user still sees what was sent
          // but the URL can't execute on click.
          return `<span class="url-link url-link--unsafe">${escapeHtml(label)}</span>`;
        }
        return `<a href="${escapeHtml(safeUrl)}" rel="nofollow noopener" target="_blank">${escapeHtml(label)}</a>`;
      }
      // `url` and `embed` are the MessagePart shapes a Harmony composer emits for a pasted URL.
      // The visible href drops tracking parameters, as the in-app renderer does.
      if (item.type === 'url' || item.type === 'embed') {
        const rawUrl = typeof item.url === 'string' ? item.url : '';
        if (!rawUrl) return '';
        const cleaned = stripTrackingParameters(rawUrl);
        const safeUrl = safeAttrUrl(cleaned);
        if (!safeUrl) {
          return `<span class="url-link url-link--unsafe">${escapeHtml(cleaned)}</span>`;
        }
        return `<a href="${escapeHtml(safeUrl)}" rel="nofollow noopener" target="_blank">${escapeHtml(cleaned)}</a>`;
      }
      if (item.type === 'emoji') {
        const name = item.emoji?.name ? String(item.emoji.name) : '';
        const rawUrl = item.emoji?.url;
        if (!name) return '';
        if (!rawUrl) {
          // Fall back to the textual `:name:` so the user still sees
          // *something* even if the emoji asset is unresolved.
          return escapeHtml(`:${name}:`);
        }
        const resolved = resolveStorageUrl(rawUrl, 'emojis', 48);
        const safeUrl = safeAttrUrl(resolved);
        if (!safeUrl) return escapeHtml(`:${name}:`);
        return `<img src="${escapeHtml(safeUrl)}" alt=":${escapeHtml(name)}:" title=":${escapeHtml(name)}:" class="custom-emoji" draggable="false">`;
      }
      if (item.type === 'role_mention') {
        const roleName = item.roleName ? String(item.roleName) : 'unknown';
        // Federated payloads can stamp arbitrary CSS in `roleColor`; allow
        // only short/long hex literals through.
        const color = typeof item.roleColor === 'string' && SAFE_HEX_COLOR.test(item.roleColor)
          ? item.roleColor
          : '';
        const styleAttr = color ? ` style="color: ${escapeHtml(color)}"` : '';
        return `<span class="mention"${styleAttr}>@${escapeHtml(roleName)}</span>`;
      }
      if (item.type === 'file') {
        // Gallery media render in the media grid, not in the text.
        const mime = String(item.mimeType || item.fileType || '');
        const rawUrl = typeof item.url === 'string' ? item.url : '';
        if (/^image/i.test(mime) || galleryUrls.has(rawUrl)) return '';
        const safeUrl = safeAttrUrl(rawUrl);
        const label = item.fileName ? String(item.fileName) : rawUrl;
        if (!safeUrl) {
          return label ? `<span class="url-link url-link--unsafe">${escapeHtml(label)}</span>` : '';
        }
        return `<a href="${escapeHtml(safeUrl)}" rel="nofollow noopener" target="_blank">${escapeHtml(label)}</a>`;
      }
      // `system` (join/leave) is internal state, not user-authored content.
      return '';
    })
    .join('');
}

export type GalleryKind = 'image' | 'gifv' | 'video' | 'audio' | 'file';

export interface GalleryItem {
  url: string;
  kind: GalleryKind;
  alt: string;
  width: number | null;
  height: number | null;
  /** CSS object-position of the focal point. */
  position: string | null;
  mime: string;
}

function mimeOf(m: any): string {
  return String(m?.mediaType || m?.media_type || m?.mime_type || m?.mimeType || '').toLowerCase();
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Kind of a media row: the declared type for composer and Mastodon rows, else by MIME type,
 * then by file extension. Mirrors src/utils/postMedia.ts galleryType.
 */
function galleryKind(m: any, url: string): GalleryKind {
  const declared = typeof m?.type === 'string' ? m.type.toLowerCase() : '';
  if (declared === 'image' || declared === 'video' || declared === 'audio' || declared === 'gifv') return declared;
  const fileType = typeof m?.fileType === 'string' ? m.fileType.toLowerCase() : '';
  if (fileType === 'image' || fileType === 'video' || fileType === 'audio') return fileType;
  const mime = mimeOf(m);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const path = url.split('?')[0].toLowerCase();
  if (/\.(jpe?g|png|gif|webp|avif)$/.test(path)) return 'image';
  if (/\.(mp4|webm|ogv|mov|m4v)$/.test(path)) return 'video';
  if (/\.(mp3|ogg|oga|opus|wav|flac|m4a)$/.test(path)) return 'audio';
  return 'file';
}

/**
 * Media of a post: `media_attachments` rows (composer, federated, Mastodon API), else the
 * content's file parts. Mirrors src/utils/postMedia.ts galleryMedia. Unsafe URLs are dropped.
 */
export function galleryMedia(post: any): GalleryItem[] {
  const attached = Array.isArray(post?.media_attachments) ? post.media_attachments : [];
  const rows: any[] = attached.length > 0
    ? attached
    : (Array.isArray(post?.content) ? post.content : []).filter((p: any) => p?.type === 'file');
  const items: GalleryItem[] = [];
  for (const m of rows) {
    const url = safeHttpUrl(m?.url || m?.remote_url || m?.href);
    if (!url) continue;
    const kind = galleryKind(m, url);
    if (attached.length === 0 && kind === 'file') continue;
    const focal = storedFocalPoint(m);
    items.push({
      url,
      kind,
      // Composer rows carry the file name in `name`; it is never alt text.
      alt: firstText(m?.description, m?.altText, m?.alt),
      width: positiveInt(m?.width ?? m?.meta?.width ?? m?.meta?.original?.width),
      height: positiveInt(m?.height ?? m?.meta?.height ?? m?.meta?.original?.height),
      position: focal ? `${round((focal[0] + 1) * 50)}% ${round((1 - focal[1]) * 50)}%` : null,
      mime: mimeOf(m),
    });
  }
  return items;
}

function firstText(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

interface DisplayNameEmoji {
  name: string;
  url: string;
}

function emojiMap(emojis?: DisplayNameEmoji[] | null): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of emojis ?? []) {
    if (!e?.name || !e?.url) continue;
    const resolvedUrl = resolveStorageUrl(e.url, 'emojis', 48);
    if (!safeAttrUrl(resolvedUrl)) continue;
    const cleanName = e.name.replace(/^:/, '').replace(/:$/, '');
    map.set(cleanName, resolvedUrl);
    map.set(cleanName.replace(/@[^@]*$/, ''), resolvedUrl);
  }
  return map;
}

/** Escaped HTML text with each known `:shortcode:` (and the U+200B spacers around it) an image. */
export function emojifyHtml(escaped: string, emojis?: DisplayNameEmoji[] | null): string {
  const map = emojiMap(emojis);
  if (map.size === 0) return escaped;
  return escaped.replace(/\u200B?:([a-zA-Z0-9_+-]+(?:@[a-zA-Z0-9._-]*)?):\u200B?/g, (match, name: string) => {
    const url = map.get(name) || map.get(name.replace(/@[^@]*$/, ''));
    if (!url) return match;
    return `<img src="${escapeHtml(url)}" alt=":${escapeHtml(name)}:" title=":${escapeHtml(name)}:" class="custom-emoji" draggable="false">`;
  });
}

export function renderDisplayNameHtml(displayName: string, emojis?: DisplayNameEmoji[] | null): string {
  if (!displayName) return '';
  return emojifyHtml(escapeHtml(displayName), emojis);
}

export function displayNameEmojis(author: any): DisplayNameEmoji[] {
  if (Array.isArray(author?.display_name_emojis) && author.display_name_emojis.length > 0) {
    return author.display_name_emojis;
  }
  try {
    const meta = typeof author?.federation_metadata === 'string'
      ? JSON.parse(author.federation_metadata)
      : author?.federation_metadata;
    if (meta?.display_name_emojis && Array.isArray(meta.display_name_emojis)) {
      return meta.display_name_emojis;
    }
  } catch { /* ignore */ }
  return [];
}

export function isLocalAuthor(author: any): boolean {
  return author?.is_local !== false;
}

/** `@user@domain`, this instance's domain for a local account. */
export function authorHandle(author: any): string {
  const domain = isLocalAuthor(author) ? config.INSTANCE_DOMAIN : (author?.domain || config.INSTANCE_DOMAIN);
  return `@${author?.username}@${domain}`;
}

/** The public page of a local account; the account's page on its server otherwise. */
export function authorHref(author: any): string {
  if (isLocalAuthor(author)) return `https://${config.INSTANCE_DOMAIN}/@${encodeURIComponent(author.username)}`;
  return safeHttpUrl(author?.url) || safeHttpUrl(author?.federated_id) || `https://${author?.domain}/users/${author?.username}`;
}

/** The public page of a local post; the post's page on its server otherwise. */
export function postPermalink(post: any, author: any): string {
  if (isLocalAuthor(author) && post?.is_local !== false) {
    return `https://${config.INSTANCE_DOMAIN}/@${encodeURIComponent(author.username)}/${post.id}`;
  }
  return safeHttpUrl(post?.url) || safeHttpUrl(post?.ap_id) || `https://${config.INSTANCE_DOMAIN}/posts/${post?.id}`;
}

function avatarSrc(author: any, size: number): string {
  return absoluteUrl(resolveStorageUrl(author?.avatar_url, 'avatars', size)) || `https://${config.INSTANCE_DOMAIN}/default_avatar.webp`;
}

/** Original avatar for link-preview cards: a render can answer WebP, which some crawlers skip. */
export function avatarOriginal(author: any): string {
  return absoluteUrl(originalStorageUrl(author?.avatar_url, 'avatars')) || `https://${config.INSTANCE_DOMAIN}/default_avatar.webp`;
}

function mediaHtml(items: GalleryItem[]): string {
  const shown = items.filter((m) => m.kind !== 'file');
  if (shown.length === 0) return '';
  const layout = shown.length > 4 ? 'many' : String(shown.length);
  const cells = shown.map((m) => {
    const alt = m.alt;
    const altAttr = escapeHtml(alt);
    const badge = alt ? `<span class="alt-badge" title="${altAttr}">ALT</span>` : '';
    const ratio = shown.length === 1 && m.width && m.height
      ? ` style="aspect-ratio: ${m.width} / ${m.height}"`
      : '';
    const position = m.position ? ` style="object-position: ${m.position}"` : '';
    const src = escapeHtml(m.url);
    if (m.kind === 'image') {
      return `<a class="media-item" href="${src}" target="_blank" rel="noopener"${ratio}><img src="${src}" alt="${altAttr}" loading="lazy" decoding="async"${position}${m.width ? ` width="${m.width}"` : ''}${m.height ? ` height="${m.height}"` : ''}>${badge}</a>`;
    }
    if (m.kind === 'gifv') {
      return `<div class="media-item"${ratio}><video src="${src}" aria-label="${altAttr}" autoplay muted loop playsinline preload="metadata"${position}></video>${badge}</div>`;
    }
    if (m.kind === 'video') {
      return `<div class="media-item"${ratio}><video src="${src}" aria-label="${altAttr}" controls playsinline preload="metadata"${position}></video>${badge}</div>`;
    }
    return `<div class="media-item media-audio"><audio src="${src}" aria-label="${altAttr}" controls preload="none"></audio>${badge}</div>`;
  });
  const files = items.filter((m) => m.kind === 'file').map((m) =>
    `<a class="media-file" href="${escapeHtml(m.url)}" rel="nofollow noopener" target="_blank">${icon('file')}${escapeHtml(m.alt || m.url.split('/').pop() || m.url)}</a>`);
  return `<div class="media-grid media-${layout}${shown.length === 1 ? ' single' : ' multi'}">${cells.join('')}</div>${files.join('')}`;
}

function pollHtml(poll: any, ctx: PageContext): string {
  if (!poll || !Array.isArray(poll.options)) return '';
  const count = (v: unknown) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const options = poll.options
    .map((o: any) => ({ name: String(o?.name ?? ''), votes: count(o?.votes) }))
    .filter((o: { name: string }) => o.name);
  if (options.length === 0) return '';
  const sum = options.reduce((acc: number, o: { votes: number }) => acc + o.votes, 0);
  const voters = count(poll.voters_count) || sum;
  const denominator = poll.multiple ? voters : sum;
  const top = Math.max(...options.map((o: { votes: number }) => o.votes));
  const end = typeof poll.end_time === 'string' ? poll.end_time : null;
  const ended = poll.closed === true || (end !== null && Date.parse(end) <= Date.now());
  const rows = options.map((o: { name: string; votes: number }) => {
    const percent = denominator > 0 ? Math.min(100, Math.round((o.votes / denominator) * 100)) : 0;
    const lead = top > 0 && o.votes === top ? ' lead' : '';
    return `<li class="poll-option${lead}"><span class="poll-bar" style="width: ${percent}%"></span><span class="poll-label">${escapeHtml(o.name)}</span><span class="poll-pct">${percent}%</span></li>`;
  });
  const state = ended
    ? escapeHtml(ctx.t.pollClosed)
    : end ? fillHtml(ctx.t.pollEnds, { date: timeHtml(end, ctx.locale, true) }) : '';
  const people = escapeHtml(fillText(ctx.t.pollPeople, { count: formatCount(voters, ctx.locale) }));
  return `<div class="poll"><ul>${rows.join('')}</ul><p class="poll-meta">${people}${state ? ` · ${state}` : ''}</p></div>`;
}

function quoteHtml(quote: any, ctx: PageContext): string {
  if (!quote?.author) return '';
  const author = quote.author;
  const name = renderDisplayNameHtml(author.display_name || author.username, displayNameEmojis(author));
  const text = quote.content_warning
    ? `<span class="quote-cw">${escapeHtml(quote.content_warning)}</span>`
    : escapeHtml(truncate(extractPlainText(quote.content), 320));
  const image = quote.content_warning || quote.is_sensitive ? null : galleryMedia(quote).find((m) => m.kind === 'image');
  return `<a class="quote" href="${escapeHtml(postPermalink(quote, author))}" data-testid="public-quote">
  <span class="quote-head"><img class="avatar avatar-xs" src="${escapeHtml(avatarSrc(author, 48))}" alt="" loading="lazy"><span class="display-name">${name}</span><span class="handle">${escapeHtml(authorHandle(author))}</span></span>
  ${text ? `<span class="quote-text">${text}</span>` : ''}
  ${image ? `<img class="quote-image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" loading="lazy"${image.position ? ` style="object-position: ${image.position}"` : ''}>` : ''}
  ${timeHtml(quote.created_at, ctx.locale)}
</a>`;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : text;
}

export interface PostCardOptions {
  /** 'page': the post's own page (h1-level, full date); 'feed': a profile's list. */
  level: 'page' | 'feed';
  pinned?: boolean;
}

/** One post as an article. `post.author` names its author. */
export function renderPostCard(post: any, ctx: PageContext, opts: PostCardOptions): string {
  const author = post.author ?? {};
  const media = galleryMedia(post);
  const galleryUrls = new Set(media.map((m) => m.url));
  const contentHtml = extractContentHtml(post.content, galleryUrls);
  const permalink = postPermalink(post, author);
  const nameHtml = renderDisplayNameHtml(author.display_name || author.username, displayNameEmojis(author));

  const replyTo = post.reply_to?.author
    ? `<p class="reply-to">${icon('reply')}${fillHtml(ctx.t.replyingTo, {
      handle: `<a href="${escapeHtml(postPermalink(post.reply_to, post.reply_to.author))}">${escapeHtml(authorHandle(post.reply_to.author))}</a>`,
    })}</p>`
    : '';

  const mediaBlock = media.length === 0
    ? ''
    : post.is_sensitive && !post.content_warning
      ? `<details class="sensitive"><summary>${icon('eyeOff')}<span>${escapeHtml(ctx.t.sensitive)}</span><span class="toggle"><span class="more">${escapeHtml(ctx.t.showMore)}</span><span class="less">${escapeHtml(ctx.t.showLess)}</span></span></summary>${mediaHtml(media)}</details>`
      : mediaHtml(media);
  const body = `<div class="content"${post.language ? ` lang="${escapeHtml(String(post.language))}"` : ''}>${contentHtml}</div>${mediaBlock}${pollHtml(post.poll, ctx)}${quoteHtml(post.quote, ctx)}`;
  const warned = post.content_warning
    ? `<div class="content-warning">${escapeHtml(post.content_warning)}</div>
<details class="cw-body"><summary><span class="toggle"><span class="more">${escapeHtml(ctx.t.showMore)}</span><span class="less">${escapeHtml(ctx.t.showLess)}</span></span></summary>${body}</details>`
    : body;

  const stat = (name: 'reply' | 'boost' | 'heart', label: string, n: unknown) =>
    `<span class="stat" title="${escapeHtml(label)}">${icon(name, label)}<span class="stat-count">${formatCount(n, ctx.locale)}</span></span>`;
  const flags: string[] = [];
  if (post.visibility === 'unlisted') flags.push(`<span class="visibility-badge">${icon('eyeOff')}${escapeHtml(ctx.t.unlisted)}</span>`);
  if (post.edited_at) flags.push(`<span class="edited" title="${escapeHtml(post.edited_at)}">${escapeHtml(ctx.t.edited)}</span>`);

  return `<article class="card post post-${opts.level}" data-testid="public-post" data-post-id="${escapeHtml(String(post.id))}">
  ${opts.pinned ? `<p class="pinned-label">${icon('pin')}${escapeHtml(ctx.t.pinned)}</p>` : ''}
  <header class="post-head">
    <a href="${escapeHtml(authorHref(author))}" class="author"><img src="${escapeHtml(avatarSrc(author, 96))}" alt="" class="avatar" loading="lazy"><span class="author-info"><span class="display-name">${nameHtml}</span><span class="handle"><!--email_off-->${escapeHtml(authorHandle(author))}<!--/email_off--></span></span></a>
    <a class="post-time" href="${escapeHtml(permalink)}">${timeHtml(post.created_at, ctx.locale, opts.level === 'page')}</a>
  </header>
  ${replyTo}
  ${warned}
  <div class="stats-bar">${stat('reply', ctx.t.replies, post.replies_count)}${stat('boost', ctx.t.boosts, post.reblogs_count)}${stat('heart', ctx.t.favourites, post.favorites_count)}${flags.length ? `<span class="flags">${flags.join('')}</span>` : ''}</div>
</article>`;
}

export interface PostPageOptions {
  /** noindex regardless of the post: the pages are off, or this is not the canonical URL. */
  noindex?: boolean;
}

/**
 * The page of one post. `author` is the post's author; `ctx` defaults to English and this
 * instance's configured name.
 */
export function renderPostPage(post: any, author: any, ctx?: PageContext, options: PostPageOptions = {}): string {
  const context = ctx ?? pageContext('en', pageInstance(null), `/posts/${post.id}`);
  const full = { ...post, author };
  const domain = config.INSTANCE_DOMAIN;
  const remote = !isLocalAuthor(author) || post.is_local === false;
  const canonical = postPermalink(full, author);
  const apObjectUrl = safeHttpUrl(post.ap_id) || `https://${domain}/posts/${post.id}`;
  const oembedUrl = `https://${domain}/oembed?url=${encodeURIComponent(`https://${domain}/posts/${post.id}`)}&format=json`;

  const plainText = extractPlainText(post.content);
  const media = galleryMedia(full);
  const firstImage = post.content_warning || post.is_sensitive ? undefined : media.find((m) => m.kind === 'image');

  const nameHtml = renderDisplayNameHtml(author.display_name || author.username, displayNameEmojis(author));
  const displayNamePlain = plainDisplayName(author.display_name, author.username);
  const handle = authorHandle(author);

  const ogDescription = post.content_warning
    ? `CW: ${post.content_warning}`
    : plainText.length > 200
      ? plainText.substring(0, 197) + '...'
      : plainText || fillText(context.t.postBy, { name: displayNamePlain });
  const titleText = post.content_warning ? `CW: ${post.content_warning}` : ogDescription;
  const title = `${displayNamePlain}: "${titleText.substring(0, 80)}${titleText.length > 80 ? '...' : ''}"`;

  const noindex = options.noindex === true || remote || post.visibility === 'unlisted' || author.discoverable === false;
  const localAuthor = !remote;
  const inApp = `/social/post/${post.id}`;

  const back = localAuthor
    ? `<a class="back" href="${escapeHtml(authorHref(author))}">${icon('arrowLeft')}<span>${fillHtml(context.t.moreFrom, { name: nameHtml })}</span></a>`
    : '';

  return renderShell({
    ctx: context,
    title: `${title} - ${context.instance.name}`,
    description: ogDescription,
    canonical,
    noindex,
    ogType: 'article',
    ogTitle: `${displayNamePlain} (${handle})`,
    ogImage: firstImage ? firstImage.url : avatarOriginal(author),
    ogImageAlt: firstImage?.alt || null,
    ogImageWidth: firstImage?.width ?? null,
    ogImageHeight: firstImage?.height ?? null,
    twitterCard: firstImage ? 'summary_large_image' : 'summary',
    activityPubUrl: apObjectUrl,
    extraHead: [
      `<link rel="alternate" type="application/json+oembed" href="${escapeHtml(oembedUrl)}" title="${escapeHtml(title)}">`,
      post.created_at ? `<meta property="article:published_time" content="${escapeHtml(post.created_at)}">` : '',
    ].filter(Boolean).join('\n  '),
    handOff: {
      app: localAuthor ? `/@${encodeURIComponent(author.username)}/${post.id}` : inApp,
      fallback: inApp,
    },
    body: `${back}
${renderPostCard(full, context, { level: 'page' })}
${joinCard(context, nameHtml)}`,
  });
}

export function renderOEmbed(post: any, author: any): object {
  const domain = config.INSTANCE_DOMAIN;
  const instanceName = config.INSTANCE_NAME;
  const plainText = extractPlainText(post.content);
  const displayName = plainDisplayName(author.display_name, author.username);
  const handle = authorHandle(author);
  const authorUrl = authorHref(author);

  return {
    version: '1.0',
    type: 'rich',
    title: plainText.substring(0, 100) || `Post by ${displayName}`,
    author_name: `${displayName} (${handle})`,
    author_url: authorUrl,
    provider_name: instanceName,
    provider_url: `https://${domain}`,
    url: postPermalink(post, author),
    html: `<blockquote><p>${escapeHtml(plainText)}</p>&mdash; ${escapeHtml(displayName)} (<a href="${escapeHtml(authorUrl)}">${escapeHtml(handle)}</a>)</blockquote>`,
    width: 600,
    height: null,
  };
}

export { extractPlainText };
