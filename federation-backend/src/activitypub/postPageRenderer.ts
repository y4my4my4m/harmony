/**
 * Renders a public HTML page for a post, including OG meta tags for link
 * previews on Mastodon, Discord, Slack, Twitter, and other platforms.
 *
 * This is the page browsers and crawlers see at /posts/:id.
 * ActivityPub clients receive JSON instead (handled in OutboxHandler).
 */

import config from '../config/index.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
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
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((item: any) => {
      if (item.type === 'text') {
        let text = escapeHtml(item.text || '');
        text = text.replace(/\n/g, '<br>');
        return text;
      }
      if (item.type === 'mention') {
        const domain = item.domain || config.INSTANCE_DOMAIN;
        const username = item.username || 'unknown';
        const href = `https://${domain}/users/${username}`;
        const display = item.isLocal ? `@${username}` : `@${username}@${domain}`;
        return `<a href="${escapeHtml(href)}" class="mention">${escapeHtml(display)}</a>`;
      }
      if (item.type === 'hashtag') {
        return `<span class="hashtag">#${escapeHtml(item.name)}</span>`;
      }
      if (item.type === 'link') {
        const url = item.url || '#';
        const label = item.text || item.url || 'link';
        return `<a href="${escapeHtml(url)}" rel="nofollow noopener" target="_blank">${escapeHtml(label)}</a>`;
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

export function renderPostPage(post: any, author: any): string {
  const domain = config.INSTANCE_DOMAIN;
  const instanceName = config.INSTANCE_NAME;
  const postUrl = `https://${domain}/posts/${post.id}`;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const oembedUrl = `https://${domain}/oembed?url=${encodeURIComponent(postUrl)}&format=json`;

  const plainText = extractPlainText(post.content);
  const contentHtml = extractContentHtml(post.content);
  const images = extractImages(post.content);
  const firstImage = images[0];

  const displayName = escapeHtml(author.display_name || author.username);
  const handle = `@${author.username}@${domain}`;

  // OG description: truncated plain text
  const ogDescription = plainText.length > 200
    ? plainText.substring(0, 197) + '...'
    : plainText || `Post by ${displayName}`;

  const ogTitle = post.content_warning
    ? `CW: ${escapeHtml(post.content_warning)}`
    : `${displayName}: "${ogDescription.substring(0, 80)}${ogDescription.length > 80 ? '...' : ''}"`;

  const avatarUrl = author.avatar_url || `https://${domain}/default-avatar.png`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ogTitle} - ${escapeHtml(instanceName)}</title>

  <!-- Open Graph -->
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="${escapeHtml(instanceName)}">
  <meta property="og:title" content="${escapeHtml(displayName)} (${escapeHtml(handle)})">
  <meta property="og:description" content="${escapeHtml(ogDescription)}">
  <meta property="og:url" content="${escapeHtml(postUrl)}">
  ${firstImage ? `<meta property="og:image" content="${escapeHtml(firstImage.url)}">
  ${firstImage.width ? `<meta property="og:image:width" content="${firstImage.width}">` : ''}
  ${firstImage.height ? `<meta property="og:image:height" content="${firstImage.height}">` : ''}` : `<meta property="og:image" content="${escapeHtml(avatarUrl)}">`}

  <!-- Twitter Card -->
  <meta name="twitter:card" content="${firstImage ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${escapeHtml(displayName)} (${escapeHtml(handle)})">
  <meta name="twitter:description" content="${escapeHtml(ogDescription)}">
  ${firstImage ? `<meta name="twitter:image" content="${escapeHtml(firstImage.url)}">` : ''}

  <!-- oEmbed discovery -->
  <link rel="alternate" type="application/json+oembed" href="${escapeHtml(oembedUrl)}" title="${escapeHtml(ogTitle)}">

  <!-- ActivityPub alternate -->
  <link rel="alternate" type="application/activity+json" href="${escapeHtml(postUrl)}">

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      line-height: 1.6;
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
      background: #161b22;
      border: 1px solid #30363d;
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
      background: #30363d;
    }
    .author-info { flex: 1; min-width: 0; }
    .display-name {
      font-weight: 600;
      font-size: 15px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .handle {
      color: #8b949e;
      font-size: 13px;
    }
    .content-warning {
      background: #1c2128;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
      color: #f0883e;
      font-weight: 500;
    }
    .content {
      font-size: 15px;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .content a {
      color: #58a6ff;
      text-decoration: none;
    }
    .content a:hover { text-decoration: underline; }
    .content .mention { color: #58a6ff; }
    .content .hashtag { color: #58a6ff; }
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
    .meta {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid #21262d;
      color: #8b949e;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .meta a { color: #8b949e; text-decoration: none; }
    .meta a:hover { color: #58a6ff; }
    .cta {
      display: block;
      text-align: center;
      padding: 12px 24px;
      background: #238636;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
    }
    .cta:hover { background: #2ea043; }
    .branding {
      text-align: center;
      padding: 24px 0;
      color: #484f58;
      font-size: 13px;
    }
    .branding a { color: #58a6ff; text-decoration: none; }
    .visibility-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      background: #1c2128;
      border: 1px solid #30363d;
      color: #8b949e;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="post-card">
      <a href="${escapeHtml(authorUrl)}" class="author">
        <img src="${escapeHtml(avatarUrl)}" alt="${displayName}" class="avatar" loading="lazy">
        <div class="author-info">
          <div class="display-name">${displayName}</div>
          <div class="handle">${escapeHtml(handle)}</div>
        </div>
      </a>

      ${post.content_warning ? `<div class="content-warning">Content Warning: ${escapeHtml(post.content_warning)}</div>` : ''}

      <div class="content">${contentHtml}</div>

      ${images.length > 0 ? `
      <div class="media-grid ${images.length === 1 ? 'single' : 'multi'}">
        ${images.map(img => `<img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || '')}" loading="lazy">`).join('\n        ')}
      </div>` : ''}

      <div class="meta">
        <time datetime="${escapeHtml(post.created_at)}">${formatDate(post.created_at)}</time>
        <span class="visibility-badge">${escapeHtml(post.visibility || 'public')}</span>
      </div>
    </div>

    <a href="https://${escapeHtml(domain)}" class="cta">View on ${escapeHtml(instanceName)}</a>

    <div class="branding">
      Powered by <a href="https://github.com/harmonyonline/harmony">Harmony</a> &mdash;
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
