/**
 * Link-preview page of a Drive file's address, /d/:token. Link-preview crawlers reach it
 * through the reverse proxy's User-Agent map; people get the SPA at the same URL.
 *
 * It shows what the public page shows anyone: the file's name and type, and for a raster image
 * a thumbnail through the link route; never the owner. public.drive_link_resolve answers only
 * while the file's general access is "Anyone with the link" (live link share, file in Drive,
 * link sharing on); a restricted, expired or unknown token gets a page with no file metadata.
 */

import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { escapeHtml } from '../utils/html.js';
import { logger } from '../utils/logger.js';
import { LINK_THUMBNAIL_TYPES } from '../utils/privateMedia.js';
import { THEME_COLOR, truncate } from './invitePageRenderer.js';

/** drive_files.link_token: base64url of 18 random bytes. Same bounds as routes/driveLink.ts. */
export const DRIVE_LINK_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;


/** Code points of the file name in og:title. */
const NAME_LIMIT = 200;

/** public/img/app_icon_square.png, 526x526. */
const DEFAULT_IMAGE = { path: '/img/app_icon_square.png', width: 526, height: 526 };

const KIND_LABELS: Record<string, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  other: 'File',
};

export interface DriveLinkPreview {
  token: string;
  name: string;
  mimeType: string | null;
  kind: string;
}

export type DriveLinkPreviewResult =
  | { status: 'valid'; preview: DriveLinkPreview }
  | { status: 'invalid' }
  | { status: 'unavailable' };

export function driveLinkPageUrl(token: string): string {
  return `https://${config.INSTANCE_DOMAIN}/d/${token}`;
}

/** Not memoised: a revoked link stops showing at once. */
export async function loadDriveLinkPreview(token: string): Promise<DriveLinkPreviewResult> {
  if (!DRIVE_LINK_TOKEN.test(token)) return { status: 'invalid' };
  let data: any;
  try {
    const answer = await getSupabaseClient().rpc('drive_link_resolve', { p_token: token });
    if (answer.error) throw new Error(answer.error.message);
    data = answer.data;
  } catch (err) {
    logger.warn(`drive_link_resolve failed: ${(err as Error).message}`);
    return { status: 'unavailable' };
  }
  if (!data || typeof data !== 'object' || typeof data.name !== 'string') return { status: 'invalid' };
  return {
    status: 'valid',
    preview: {
      token,
      name: data.name.trim() || 'file',
      mimeType: typeof data.mime_type === 'string' && data.mime_type ? data.mime_type : null,
      kind: typeof data.kind === 'string' && data.kind in KIND_LABELS ? data.kind : 'other',
    },
  };
}

/** "Image · image/png": the kind, and the MIME type when known. */
export function driveLinkDescription(preview: DriveLinkPreview): string {
  const kind = KIND_LABELS[preview.kind] ?? 'File';
  return preview.mimeType ? `${kind} · ${preview.mimeType}` : kind;
}

/** Thumbnail of a raster image through the link route, else null. */
export function driveLinkThumbnail(preview: DriveLinkPreview): string | null {
  if (preview.kind !== 'image' || !preview.mimeType || !LINK_THUMBNAIL_TYPES.has(preview.mimeType)) return null;
  return `https://${config.INSTANCE_DOMAIN}/api/federation/drive/link/${preview.token}?thumb=1`;
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
    .thumb { display: block; width: 100%; max-height: 320px; object-fit: contain; background: #0b0d12; }
    .body { padding: 20px; }
    h1 { font-size: 20px; line-height: 1.25; overflow-wrap: anywhere; }
    .type { color: #b5bac1; font-size: 14px; margin-top: 4px; }
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
    }`;

/** Page of a live link. */
export function renderDriveLinkPage(preview: DriveLinkPreview): string {
  const instanceName = config.INSTANCE_NAME;
  const url = driveLinkPageUrl(preview.token);
  const title = truncate(preview.name, NAME_LIMIT);
  const description = driveLinkDescription(preview);
  const thumb = driveLinkThumbnail(preview);
  const image = thumb
    ? { url: thumb, alt: title, card: 'summary_large_image', width: 0, height: 0 }
    : { url: `https://${config.INSTANCE_DOMAIN}${DEFAULT_IMAGE.path}`, alt: instanceName, card: 'summary',
        width: DEFAULT_IMAGE.width, height: DEFAULT_IMAGE.height };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)} - ${escapeHtml(instanceName)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="${THEME_COLOR}">
  <link rel="canonical" href="${escapeHtml(url)}">

  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtml(instanceName)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${escapeHtml(image.url)}">
  <meta property="og:image:alt" content="${escapeHtml(image.alt)}">
  ${image.width ? `<meta property="og:image:width" content="${image.width}">\n  <meta property="og:image:height" content="${image.height}">` : ''}
  <meta name="twitter:card" content="${image.card}">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(image.url)}">

  <style>${STYLE}
  </style>
</head>
<body>
  <main class="card">
    ${thumb ? `<img class="thumb" src="${escapeHtml(thumb)}" alt="${escapeHtml(title)}">` : ''}
    <div class="body">
      <h1>${escapeHtml(title)}</h1>
      <p class="type">${escapeHtml(description)}</p>
      <a class="cta" href="${escapeHtml(url)}">Open in ${escapeHtml(instanceName)}</a>
    </div>
  </main>
</body>
</html>`;
}

/**
 * Restricted, expired, reset, unknown or malformed token and link sharing off ('invalid'), or a
 * failed lookup ('unavailable'): no OpenGraph tags at all, so an unfurler shows the bare URL.
 */
export function renderDriveLinkUnavailablePage(reason: 'invalid' | 'unavailable'): string {
  const [heading, text] = reason === 'invalid'
    ? ['This link does not work', 'It expired, or its owner stopped sharing the file.']
    : ['This link cannot be previewed', `Open it in ${config.INSTANCE_NAME} to see the file.`];
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(config.INSTANCE_NAME)}</title>
  <style>${STYLE}
  </style>
</head>
<body>
  <main class="card">
    <div class="body">
      <h1>${escapeHtml(heading)}</h1>
      <p class="type">${escapeHtml(text)}</p>
    </div>
  </main>
</body>
</html>`;
}
