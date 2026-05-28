/**
 * Renders a public HTML page for a post, including OG meta tags for link
 * previews on Mastodon, Discord, Slack, Twitter, and other platforms.
 *
 * This is the page browsers and crawlers see at /posts/:id.
 * ActivityPub clients receive JSON instead (handled in OutboxHandler).
 */

import config from '../config/index.js';

/**
 * Resolve a Supabase storage URL to a full absolute URL using the render
 * (imgproxy) path for on-the-fly resizing. Falls through for already-absolute
 * URLs (e.g. federated avatars/emojis from other instances).
 */
function resolveStorageUrl(
  raw: string | null | undefined,
  bucket: string,
  width?: number,
  height?: number,
): string {
  if (!raw || typeof raw !== 'string') return '';

  // Already a full URL - append transform query params if it's our Supabase
  // storage URL and no transforms are present yet
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    if (width && raw.includes('/storage/v1/') && !raw.includes('width=')) {
      const sep = raw.includes('?') ? '&' : '?';
      return `${raw}${sep}width=${width}&height=${height || width}&resize=contain&quality=80`;
    }
    return raw;
  }
  if (raw.startsWith('/')) return raw;

  const base = config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL || '';
  if (!base) return raw;

  if (width) {
    return `${base}/storage/v1/render/image/public/${bucket}/${raw}?width=${width}&height=${height || width}&resize=contain&quality=80`;
  }
  return `${base}/storage/v1/object/public/${bucket}/${raw}`;
}

function escapeHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
 * unsafe scheme. Strips ASCII control characters first — browsers ignore
 * tabs/newlines inside URL schemes, which is a well-known XSS bypass
 * (`java\tscript:`).
 *
 * The returned value still needs to be passed through `escapeHtml` when
 * inlined into an HTML attribute. Pattern:
 *   `<a href="${escapeHtml(safeAttrUrl(url))}">`
 */
function safeAttrUrl(url: string | null | undefined): string {
  if (url == null) return '';
  const cleaned = String(url).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return '';
  const schemeMatch = /^([a-z][a-z0-9+.\-]*):/i.exec(cleaned);
  if (!schemeMatch) {
    // Scheme-less: relative path / protocol-relative / fragment. Allowed.
    return cleaned;
  }
  const scheme = schemeMatch[1].toLowerCase() + ':';
  if (!SAFE_URL_SCHEMES.has(scheme)) return '';
  return cleaned;
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
      return '';
    })
    .join('')
    .trim();
}

function extractContentHtml(content: any): string {
  // Defensive: the DB constraint `posts_content_is_array` should make
  // this path unreachable, but if a string ever slipped through (e.g.
  // an early migration / federation import) we MUST escape it before
  // inlining into the post page — returning it raw would let a stored
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
        const href = safeAttrUrl(`https://${domain}/users/${username}`);
        const display = item.isLocal ? `@${username}` : `@${username}@${domain}`;
        return `<a href="${escapeHtml(href)}" class="mention">${escapeHtml(display)}</a>`;
      }
      if (item.type === 'hashtag') {
        return `<span class="hashtag">#${escapeHtml(item.name)}</span>`;
      }
      if (item.type === 'link') {
        // Scheme-validate the URL before inlining as `href` — a federated
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
      return '';
    })
    .join('');
}

interface ImageAttachment {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  mediaType?: string;
}

function extractImages(content: any): ImageAttachment[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item: any) => item.type === 'file' && /^image/i.test(item.mimeType || item.fileType || ''))
    .map((item: any) => ({
      url: item.url,
      alt: item.altText || item.description || undefined,
      width: item.width,
      height: item.height,
      mediaType: item.mimeType || undefined,
    }));
}

function formatDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoDate;
  }
}

interface DisplayNameEmoji {
  name: string;
  url: string;
}

function renderDisplayNameHtml(displayName: string, emojis?: DisplayNameEmoji[]): string {
  if (!displayName) return '';
  if (!emojis || emojis.length === 0) return escapeHtml(displayName);

  const emojiMap = new Map<string, string>();
  for (const e of emojis) {
    if (!e.name || !e.url) continue;
    const resolvedUrl = resolveStorageUrl(e.url, 'emojis', 48);
    const cleanName = e.name.replace(/^:/, '').replace(/:$/, '');
    emojiMap.set(cleanName, resolvedUrl);
    const nameWithoutDomain = cleanName.replace(/@[^@]*$/, '');
    emojiMap.set(nameWithoutDomain, resolvedUrl);
  }

  let result = escapeHtml(displayName);
  const emojiRegex = /\u200b?:([a-zA-Z0-9_]+(?:@[a-zA-Z0-9._-]*)?):?\u200b?/g;

  result = result.replace(emojiRegex, (match, name) => {
    const cleanName = name.replace(/@[^@]*$/, '');
    const url = emojiMap.get(name) || emojiMap.get(cleanName);
    if (url) {
      return `<img src="${escapeHtml(url)}" alt=":${escapeHtml(name)}:" class="custom-emoji" draggable="false">`;
    }
    return match;
  });

  return result;
}

function getDisplayNameEmojis(author: any): DisplayNameEmoji[] {
  try {
    const meta = typeof author.federation_metadata === 'string'
      ? JSON.parse(author.federation_metadata)
      : author.federation_metadata;
    if (meta?.display_name_emojis && Array.isArray(meta.display_name_emojis)) {
      return meta.display_name_emojis;
    }
  } catch { /* ignore */ }
  return [];
}

function formatCount(n: number): string {
  if (!n || n <= 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}

export function renderPostPage(post: any, author: any): string {
  const domain = config.INSTANCE_DOMAIN;
  const instanceName = config.INSTANCE_NAME;
  const postUrl = `https://${domain}/posts/${post.id}`;
  const spaPostUrl = `https://${domain}/social/post/${post.id}`;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const oembedUrl = `https://${domain}/oembed?url=${encodeURIComponent(postUrl)}&format=json`;

  const plainText = extractPlainText(post.content);
  const contentHtml = extractContentHtml(post.content);
  const images = extractImages(post.content);
  const firstImage = images[0];

  const displayNameEmojis = getDisplayNameEmojis(author);
  const displayNameHtml = renderDisplayNameHtml(author.display_name || author.username, displayNameEmojis);
  const displayNamePlain = escapeHtml(author.display_name || author.username);
  const handle = `@${author.username}@${domain}`;

  const ogDescription = plainText.length > 200
    ? plainText.substring(0, 197) + '...'
    : plainText || `Post by ${displayNamePlain}`;

  const ogTitle = post.content_warning
    ? `CW: ${escapeHtml(post.content_warning)}`
    : `${displayNamePlain}: "${ogDescription.substring(0, 80)}${ogDescription.length > 80 ? '...' : ''}"`;

  const avatarUrl = resolveStorageUrl(author.avatar_url, 'avatars', 96) || `https://${domain}/default-avatar.png`;

  const favorites = post.favorites_count || 0;
  const reblogs = post.reblogs_count || 0;
  const replies = post.replies_count || 0;
  const hasStats = favorites > 0 || reblogs > 0 || replies > 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ogTitle} - ${escapeHtml(instanceName)}</title>

  <!-- Open Graph -->
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="${escapeHtml(instanceName)}">
  <meta property="og:title" content="${escapeHtml(displayNamePlain)} (${escapeHtml(handle)})">
  <meta property="og:description" content="${escapeHtml(ogDescription)}">
  <meta property="og:url" content="${escapeHtml(postUrl)}">
  ${firstImage ? `<meta property="og:image" content="${escapeHtml(firstImage.url)}">
  ${firstImage.width ? `<meta property="og:image:width" content="${firstImage.width}">` : ''}
  ${firstImage.height ? `<meta property="og:image:height" content="${firstImage.height}">` : ''}` : `<meta property="og:image" content="${escapeHtml(avatarUrl)}">`}

  <!-- Twitter Card -->
  <meta name="twitter:card" content="${firstImage ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${escapeHtml(displayNamePlain)} (${escapeHtml(handle)})">
  <meta name="twitter:description" content="${escapeHtml(ogDescription)}">
  ${firstImage ? `<meta name="twitter:image" content="${escapeHtml(firstImage.url)}">` : ''}

  <!-- oEmbed discovery -->
  <link rel="alternate" type="application/json+oembed" href="${escapeHtml(oembedUrl)}" title="${escapeHtml(ogTitle)}">

  <!-- ActivityPub alternate -->
  <link rel="alternate" type="application/activity+json" href="${escapeHtml(postUrl)}">

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #121214;
      color: #f2f3f5;
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container {
      max-width: 600px;
      width: 100%;
      padding: 24px 16px;
    }
    .post-card {
      background: #1a1a1e;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .author {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      text-decoration: none;
      color: inherit;
    }
    .author:hover .display-name { text-decoration: underline; }
    .avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      object-fit: cover;
      background: #222327;
    }
    .author-info { flex: 1; min-width: 0; }
    .display-name {
      font-weight: 600;
      font-size: 15px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #f2f3f5;
    }
    .display-name .custom-emoji {
      height: 1.2em;
      width: auto;
      vertical-align: -0.2em;
      margin: 0 1px;
    }
    .handle {
      color: #80848e;
      font-size: 13px;
    }
    .content-warning {
      background: rgba(240, 71, 71, 0.1);
      border: 1px solid rgba(240, 71, 71, 0.2);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
      color: #f04747;
      font-weight: 500;
    }
    .content {
      font-size: 15px;
      word-wrap: break-word;
      overflow-wrap: break-word;
      color: #f2f3f5;
    }
    .content a {
      color: #0EA5E9;
      text-decoration: none;
    }
    .content a:hover { text-decoration: underline; }
    .content .mention { color: #0EA5E9; }
    .content .hashtag { color: #0EA5E9; }
    .media-grid {
      margin-top: 12px;
      display: grid;
      gap: 4px;
      border-radius: 8px;
      overflow: hidden;
    }
    .media-grid.single { grid-template-columns: 1fr; }
    .media-grid.multi { grid-template-columns: 1fr 1fr; }
    .media-grid img {
      width: 100%;
      max-height: 400px;
      object-fit: cover;
      display: block;
    }
    .stats-bar {
      display: flex;
      gap: 20px;
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      color: #80848e;
      font-size: 13px;
    }
    .stat {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .stat svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
    .stat-count {
      font-variant-numeric: tabular-nums;
    }
    .meta {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      color: #6d6f78;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .meta a { color: #6d6f78; text-decoration: none; }
    .meta a:hover { color: #0EA5E9; }
    .cta {
      display: block;
      text-align: center;
      padding: 12px 24px;
      background: #0EA5E9;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
      transition: background 0.15s;
    }
    .cta:hover { background: #4752c4; }
    .branding {
      text-align: center;
      padding: 24px 0;
      color: #6d6f78;
      font-size: 13px;
    }
    .branding a { color: #0EA5E9; text-decoration: none; }
    .visibility-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #80848e;
    }
  </style>
  <script>
    (function() {
      try {
        var keys = Object.keys(localStorage);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf('sb-') === 0 && keys[i].indexOf('-auth-token') !== -1) {
            var val = localStorage.getItem(keys[i]);
            if (val) {
              var parsed = JSON.parse(val);
              if (parsed && parsed.access_token) {
                window.location.replace("${escapeHtml(spaPostUrl)}");
                return;
              }
            }
          }
        }
      } catch(e) {}
    })();
  </script>
</head>
<body>
  <div class="container">
    <div class="post-card">
      <a href="${escapeHtml(authorUrl)}" class="author">
        <img src="${escapeHtml(avatarUrl)}" alt="${displayNamePlain}" class="avatar" loading="lazy">
        <div class="author-info">
          <div class="display-name">${displayNameHtml}</div>
          <div class="handle">${escapeHtml(handle)}</div>
        </div>
      </a>

      ${post.content_warning ? `<div class="content-warning">Content Warning: ${escapeHtml(post.content_warning)}</div>` : ''}

      <div class="content">${contentHtml}</div>

      ${images.length > 0 ? `
      <div class="media-grid ${images.length === 1 ? 'single' : 'multi'}">
        ${images.map(img => `<img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || '')}" loading="lazy">`).join('\n        ')}
      </div>` : ''}

      ${hasStats ? `
      <div class="stats-bar">
        ${replies > 0 ? `<span class="stat"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span class="stat-count">${formatCount(replies)}</span></span>` : ''}
        ${reblogs > 0 ? `<span class="stat"><svg viewBox="0 0 24 24"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg><span class="stat-count">${formatCount(reblogs)}</span></span>` : ''}
        ${favorites > 0 ? `<span class="stat"><svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg><span class="stat-count">${formatCount(favorites)}</span></span>` : ''}
      </div>` : ''}

      <div class="meta">
        <time datetime="${escapeHtml(post.created_at)}">${formatDate(post.created_at)}</time>
        <span class="visibility-badge">${escapeHtml(post.visibility || 'public')}</span>
      </div>
    </div>

    <a href="${escapeHtml(spaPostUrl)}" class="cta">View on ${escapeHtml(instanceName)}</a>

    <div class="branding">
      Powered by <a href="https://mony.lol">Harmony</a> &mdash;
      a federated social platform
    </div>
  </div>
</body>
</html>`;
}

export function renderOEmbed(post: any, author: any): object {
  const domain = config.INSTANCE_DOMAIN;
  const instanceName = config.INSTANCE_NAME;
  const plainText = extractPlainText(post.content);
  const displayName = author.display_name || author.username;
  const handle = `@${author.username}@${domain}`;

  return {
    version: '1.0',
    type: 'rich',
    title: plainText.substring(0, 100) || `Post by ${displayName}`,
    author_name: `${displayName} (${handle})`,
    author_url: `https://${domain}/users/${author.username}`,
    provider_name: instanceName,
    provider_url: `https://${domain}`,
    url: `https://${domain}/posts/${post.id}`,
    html: `<blockquote><p>${escapeHtml(plainText)}</p>&mdash; ${escapeHtml(displayName)} (<a href="https://${domain}/users/${author.username}">${escapeHtml(handle)}</a>)</blockquote>`,
    width: 600,
    height: null,
  };
}
