/**
 * Link-preview page and oEmbed of a server invite, /invite/:code. Link-preview crawlers
 * reach it through the reverse proxy's User-Agent map; people get the SPA at the same URL.
 */

import config from '../config/index.js';
import { escapeHtml, originalStorageUrl } from '../utils/html.js';
import { isDefaultServerIcon } from '../utils/urlUtils.js';
import { inviteUrl, type InvitePreview } from './invitePreview.js';

/** --harmony-primary, src/assets/design-system.css. Discord draws it as the embed bar. */
export const THEME_COLOR = '#0EA5E9';
const INVALID_THEME_COLOR = '#80848E';

/** public/img/app_icon_square.png, 526x526. PNG: some crawlers drop WebP. */
const DEFAULT_IMAGE = { path: '/img/app_icon_square.png', width: 526, height: 526 };

/** Code points of the server description in og:description; Discord cuts at 350. */
export const DESCRIPTION_LIMIT = 250;

export const INVITE_AUTHOR_LINE = "You've been invited to join a server";

const numbers = new Intl.NumberFormat('en-US');

export interface InviteImage {
  url: string;
  alt: string;
  /** summary_large_image; otherwise a summary thumbnail. */
  large: boolean;
  width?: number;
  height?: number;
}

function absoluteHttpUrl(url: string): string {
  if (url.startsWith('/') && !url.startsWith('//')) return `https://${config.INSTANCE_DOMAIN}${url}`;
  return /^https?:\/\//i.test(url) ? url : '';
}

function defaultImage(): InviteImage {
  return {
    url: `https://${config.INSTANCE_DOMAIN}${DEFAULT_IMAGE.path}`,
    alt: config.INSTANCE_NAME,
    large: false,
    width: DEFAULT_IMAGE.width,
    height: DEFAULT_IMAGE.height,
  };
}

/** Banner as a large image, else a custom icon as a thumbnail, else the instance icon. */
export function inviteImage(preview: InvitePreview): InviteImage {
  const banner = preview.banner ? absoluteHttpUrl(originalStorageUrl(preview.banner.trim(), 'server_banners')) : '';
  if (banner) return { url: banner, alt: `${preview.name} banner`, large: true };
  const icon = preview.icon && !isDefaultServerIcon(preview.icon)
    ? absoluteHttpUrl(originalStorageUrl(preview.icon.trim(), 'server_icons'))
    : '';
  if (icon) return { url: icon, alt: `${preview.name} icon`, large: false };
  return defaultImage();
}

/** Whitespace collapsed; cut to `limit` code points including the ellipsis. */
export function truncate(value: string, limit: number): string {
  const chars = Array.from(value.replace(/\s+/g, ' ').trim());
  if (chars.length <= limit) return chars.join('');
  return chars.slice(0, limit - 1).join('').trimEnd() + '…';
}

/** "1,234 members · 56 online"; no online part at 0 or when the count is absent. */
export function inviteCounts(preview: InvitePreview): string {
  const members = `${numbers.format(preview.memberCount)} ${preview.memberCount === 1 ? 'member' : 'members'}`;
  return preview.onlineCount ? `${members} · ${numbers.format(preview.onlineCount)} online` : members;
}

export function inviteDescription(preview: InvitePreview): string {
  const counts = inviteCounts(preview);
  const about = preview.description ? truncate(preview.description, DESCRIPTION_LIMIT) : '';
  return about ? `${counts} — ${about}` : counts;
}

const STYLE = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #121214;
      color: #f2f3f5;
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 24px 16px;
    }
    .card {
      max-width: 440px;
      width: 100%;
      background: #1a1a1e;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      overflow: hidden;
    }
    .banner { display: block; width: 100%; aspect-ratio: 1200 / 630; object-fit: cover; background: #222327; }
    .body { padding: 20px; }
    .head { display: flex; align-items: center; gap: 14px; }
    .icon { width: 64px; height: 64px; border-radius: 16px; object-fit: cover; background: #222327; flex-shrink: 0; }
    .eyebrow { color: #80848e; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em; }
    h1 { font-size: 20px; line-height: 1.25; overflow-wrap: anywhere; }
    .counts { color: #b5bac1; font-size: 14px; margin-top: 2px; }
    .about { color: #b5bac1; font-size: 14px; margin-top: 14px; overflow-wrap: anywhere; }
    .cta {
      display: block;
      margin-top: 18px;
      text-align: center;
      padding: 12px 24px;
      background: ${THEME_COLOR};
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
    }
    .cta:hover { background: #0284C7; }`;

function imageMeta(image: InviteImage): string {
  return [
    `<meta property="og:image" content="${escapeHtml(image.url)}">`,
    `<meta property="og:image:alt" content="${escapeHtml(image.alt)}">`,
    image.width ? `<meta property="og:image:width" content="${image.width}">` : '',
    image.height ? `<meta property="og:image:height" content="${image.height}">` : '',
    `<meta name="twitter:card" content="${image.large ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:image" content="${escapeHtml(image.url)}">`,
    `<meta name="twitter:image:alt" content="${escapeHtml(image.alt)}">`,
  ].filter(Boolean).join('\n  ');
}

interface PageParts {
  title: string;
  description: string;
  themeColor: string;
  image: InviteImage;
  /** Extra head tags, already escaped. */
  head: string;
  /** Card body, already escaped. */
  body: string;
}

function page(parts: PageParts): string {
  const instanceName = config.INSTANCE_NAME;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(parts.title)} - ${escapeHtml(instanceName)}</title>
  <meta name="description" content="${escapeHtml(parts.description)}">
  <meta name="theme-color" content="${parts.themeColor}">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtml(instanceName)}">
  <meta property="og:title" content="${escapeHtml(parts.title)}">
  <meta property="og:description" content="${escapeHtml(parts.description)}">
  ${parts.head}
  ${imageMeta(parts.image)}
  <meta name="twitter:title" content="${escapeHtml(parts.title)}">
  <meta name="twitter:description" content="${escapeHtml(parts.description)}">

  <style>${STYLE}
  </style>
</head>
<body>
  <main class="card">
${parts.body}
  </main>
</body>
</html>`;
}

/**
 * Page of a valid invite. `oembed` adds oEmbed discovery: Discord merges its author_name and
 * provider_name into the OpenGraph embed, while Mastodon and Slack take a discovered oEmbed
 * in place of OpenGraph and a link-type oEmbed carries no description or image.
 */
export function renderInvitePage(preview: InvitePreview, options: { oembed?: boolean } = {}): string {
  const url = inviteUrl(preview.code);
  const instanceName = config.INSTANCE_NAME;
  const description = inviteDescription(preview);
  const image = inviteImage(preview);
  const oembedUrl = `https://${config.INSTANCE_DOMAIN}/oembed?url=${encodeURIComponent(url)}&format=json`;

  const head = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    options.oembed
      ? `<link rel="alternate" type="application/json+oembed" href="${escapeHtml(oembedUrl)}" title="${escapeHtml(preview.name)}">`
      : '',
  ].filter(Boolean).join('\n  ');

  const about = preview.description ? truncate(preview.description, 1000) : '';
  const body = [
    image.large ? `    <img class="banner" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}">` : '',
    '    <div class="body">',
    '      <div class="head">',
    image.large ? '' : `        <img class="icon" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}">`,
    '        <div>',
    `          <p class="eyebrow">${escapeHtml(INVITE_AUTHOR_LINE)}</p>`,
    `          <h1>${escapeHtml(preview.name)}</h1>`,
    `          <p class="counts">${escapeHtml(inviteCounts(preview))}</p>`,
    '        </div>',
    '      </div>',
    about ? `      <p class="about">${escapeHtml(about)}</p>` : '',
    `      <a class="cta" href="${escapeHtml(url)}">Open in ${escapeHtml(instanceName)}</a>`,
    '    </div>',
  ].filter(Boolean).join('\n');

  return page({ title: preview.name, description, themeColor: THEME_COLOR, image, head, body });
}

function noticePage(title: string, description: string, themeColor: string, cta: { href: string; label: string }): string {
  const image = defaultImage();
  const body = [
    '    <div class="body">',
    '      <div class="head">',
    `        <img class="icon" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}">`,
    '        <div>',
    `          <h1>${escapeHtml(title)}</h1>`,
    `          <p class="counts">${escapeHtml(description)}</p>`,
    '        </div>',
    '      </div>',
    `      <a class="cta" href="${escapeHtml(cta.href)}">${escapeHtml(cta.label)}</a>`,
    '    </div>',
  ].join('\n');
  return page({ title, description, themeColor, image, head: '', body });
}

/** Not found, revoked, expired, used up or malformed: nothing of the server. */
export function renderInvalidInvitePage(): string {
  return noticePage(
    'Invite invalid or expired',
    'This invite link is invalid, expired, revoked or used up.',
    INVALID_THEME_COLOR,
    { href: `https://${config.INSTANCE_DOMAIN}/`, label: `Go to ${config.INSTANCE_NAME}` },
  );
}

/** The lookup failed: nothing about the invite either way. `code` matches INVITE_CODE. */
export function renderUnavailableInvitePage(code: string): string {
  return noticePage(
    'Server invite',
    `This invite cannot be previewed right now. Open it in ${config.INSTANCE_NAME} to see the server.`,
    THEME_COLOR,
    { href: inviteUrl(code), label: `Open in ${config.INSTANCE_NAME}` },
  );
}

export function renderInviteOEmbed(preview: InvitePreview): object {
  return {
    version: '1.0',
    type: 'link',
    title: preview.name,
    author_name: INVITE_AUTHOR_LINE,
    author_url: inviteUrl(preview.code),
    provider_name: config.INSTANCE_NAME,
    provider_url: `https://${config.INSTANCE_DOMAIN}`,
    cache_age: 300,
  };
}
