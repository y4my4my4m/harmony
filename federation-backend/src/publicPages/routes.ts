/**
 * Public profile and post pages, the HTML of
 *   GET /@:username            a local account and its public posts (?before=<post id> pages)
 *   GET /@:username/:postId    one post of that account
 *   GET /posts/:postId         one post, local or remote (its ActivityPub id)
 *
 * ActivityPub requests pass on (next()) to ActorService and OutboxHandler, which answer the
 * same URLs with the actor and the Note. instance_config public_profile_pages false sends
 * visitors to sign in; link-preview crawlers still get the page, noindex. A browser holding a
 * session is handed to the app by the page's script (layout.ts handOffScript).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { publicPageLimiter } from '../middleware/rateLimit.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { resolveLocalProfileEmojis } from '../utils/emojiResolvers.js';
import { renderPostPage } from '../activitypub/postPageRenderer.js';
import {
  pageContentSecurityPolicy,
  pageContext,
  pageInstance,
  renderStatusPage,
  type PageContext,
} from './layout.js';
import { renderProfilePage } from './profilePage.js';
import { pickPageLocale } from './strings.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Link-preview crawlers: the list of $invite_unfurl in dev/nginx-harmony.template.conf.
 * Search engines are not in it.
 */
const LINK_PREVIEW_AGENT = /(discordbot|slackbot|twitterbot|facebookexternalhit|facebot|telegrambot|whatsapp|linkedinbot|mastodon|pleroma|akkoma|misskey|summalybot|gotosocial|friendica|lemmy|cardyb|synapse|mattermost-bot|zulipurlpreview|discourse|embedly|iframely|redditbot|skypeuripreview|microsoftpreview|vkshare|viber|kakaotalk-scrap|harmonylinkpreview)/i;

export function wantsActivityPub(req: Request): boolean {
  return /application\/(activity|ld)\+json/i.test(req.headers.accept || '');
}

export function isLinkPreviewAgent(req: Request): boolean {
  return LINK_PREVIEW_AGENT.test(req.get('user-agent') ?? '');
}

function requestPath(req: Request): string {
  const url = req.originalUrl || req.url || '/';
  return url.startsWith('/') ? url : `/${url}`;
}

function context(req: Request, instance: any): PageContext {
  return pageContext(pickPageLocale(req.get('accept-language')), pageInstance(instance), requestPath(req));
}

function sendHtml(res: Response, status: number, html: string, noindex: boolean): void {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', status === 200 ? 'public, max-age=60' : 'no-store');
  // ActivityPub at the same URL; the language follows Accept-Language; crawlers get the page
  // while the pages are off; the proxy serves the app instead with the app's cookie.
  res.setHeader('Vary', 'Accept, Accept-Language, User-Agent, Cookie');
  res.setHeader('Content-Security-Policy', pageContentSecurityPolicy());
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (noindex) res.setHeader('X-Robots-Tag', 'noindex, noarchive');
  res.send(html);
}

/** Sign-in page that returns to this one. */
function sendToSignIn(req: Request, res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Accept, User-Agent, Cookie');
  res.redirect(302, `/login?redirect=${encodeURIComponent(requestPath(req))}`);
}

async function readPage(fn: string, args: Record<string, unknown>): Promise<any | null> {
  const { data, error } = await getSupabaseClient().rpc(fn, args);
  if (error) {
    logger.error(`${fn} failed: ${error.message}`);
    return null;
  }
  return data ?? null;
}

function sendUnavailable(req: Request, res: Response): void {
  res.setHeader('Retry-After', '30');
  sendHtml(res, 503, renderStatusPage(context(req, null), 'unavailable'), true);
}

/** Display name and bio emojis of local accounts, as their actors publish them. */
async function resolveLocalEmojis(accounts: any[]): Promise<void> {
  const seen = new Set<string>();
  await Promise.all(accounts.map(async (account) => {
    if (!account || account.is_local === false || !account.id || seen.has(account.id)) return;
    seen.add(account.id);
    const probe: any = { username: account.username, display_name: account.display_name, bio: account.bio ?? null, federation_metadata: {} };
    try {
      await resolveLocalProfileEmojis(probe);
    } catch (error) {
      logger.warn(`profile emojis of ${account.username}: ${(error as Error).message}`);
      return;
    }
    const meta = probe.federation_metadata ?? {};
    if (Array.isArray(meta.display_name_emojis)) account.display_name_emojis = meta.display_name_emojis;
    if (Array.isArray(meta.bio_emojis)) account.bio_emojis = meta.bio_emojis;
  }));
}

function postAuthors(posts: any[]): any[] {
  return posts.flatMap((p) => [p?.author, p?.quote?.author, p?.reply_to?.author]).filter(Boolean);
}

/** One author object for every post, quote and reply target of the same account. */
function shareAccount(account: any, posts: any[]): void {
  for (const post of posts) {
    for (const holder of [post, post?.quote, post?.reply_to]) {
      if (holder?.author?.id === account.id) holder.author = { ...holder.author, ...account };
    }
  }
}

router.get(
  '/@:username',
  publicPageLimiter,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (wantsActivityPub(req)) return next();
    const username = String(req.params.username ?? '');
    if (!USERNAME_RE.test(username)) {
      // A remote account (@user@domain) is the app's: shown to signed-in readers.
      if (/^[^@/]+@[^@/]+$/.test(username)) return res.redirect(302, `/social/profile/${encodeURIComponent(username).replace(/%40/g, '@')}`);
      return sendHtml(res, 404, renderStatusPage(context(req, null), 'not_found'), true);
    }
    const before = typeof req.query.before === 'string' && UUID_RE.test(req.query.before) ? req.query.before.toLowerCase() : null;

    const page = await readPage('public_profile_page', { p_username: username, p_before: before, p_limit: 20 });
    if (!page) return sendUnavailable(req, res);
    const crawler = isLinkPreviewAgent(req);
    if (page.enabled === false && !crawler) return sendToSignIn(req, res);

    const ctx = context(req, page.instance);
    if (!page.account) {
      const inApp = { app: `/@${username}`, fallback: `/social/profile/${username}` };
      return sendHtml(res, 404, renderStatusPage(ctx, 'not_found', inApp), true);
    }
    if (page.account.username !== username) {
      const query = before ? `?before=${before}` : '';
      return res.redirect(301, `/@${encodeURIComponent(page.account.username)}${query}`);
    }

    const pinned = Array.isArray(page.pinned) ? page.pinned : [];
    const posts = Array.isArray(page.posts) ? page.posts : [];
    await resolveLocalEmojis([page.account, ...postAuthors([...pinned, ...posts])]);
    shareAccount(page.account, [...pinned, ...posts]);

    const noindex = page.enabled === false;
    const html = renderProfilePage(
      { account: page.account, pinned, posts, next: page.next ?? null },
      ctx,
      { noindex, before },
    );
    return sendHtml(res, 200, html, noindex || page.account.discoverable === false || Boolean(before) || Boolean(page.account.moved_to_uri));
  })
);

/**
 * HTML of one post. `username` is the account named in the URL (/@<username>/<id>); a post of
 * another account, or of a remote one, is not found there.
 */
export async function sendPublicPostPage(req: Request, res: Response, postId: string, username: string | null): Promise<void> {
  if (!UUID_RE.test(postId)) {
    sendHtml(res, 404, renderStatusPage(context(req, null), 'not_found'), true);
    return;
  }
  const page = await readPage('public_post_page', { p_post_id: postId.toLowerCase() });
  if (!page) return sendUnavailable(req, res);
  const crawler = isLinkPreviewAgent(req);
  if (page.enabled === false && !crawler) return sendToSignIn(req, res);

  const ctx = context(req, page.instance);
  const post = page.post;
  const author = post?.author;
  const local = author && author.is_local !== false && post.is_local !== false;
  // A post the page does not show (followers-only, direct) may be one a signed-in reader sees.
  const inApp = { app: `/social/post/${postId.toLowerCase()}`, fallback: `/social/post/${postId.toLowerCase()}` };
  if (!post || !author || (username !== null && !local)) {
    sendHtml(res, 404, renderStatusPage(ctx, 'not_found', inApp), true);
    return;
  }
  if (username !== null && author.username !== username) {
    if (author.username.toLowerCase() !== username.toLowerCase()) {
      sendHtml(res, 404, renderStatusPage(ctx, 'not_found', inApp), true);
      return;
    }
    res.redirect(301, `/@${encodeURIComponent(author.username)}/${post.id}`);
    return;
  }

  await resolveLocalEmojis(postAuthors([post]));
  // /posts/<id> of a local post is the same page as /@<username>/<id>: canonical there.
  const noindex = page.enabled === false;
  const html = renderPostPage(post, author, ctx, { noindex });
  const robots = noindex || !local || post.visibility === 'unlisted' || author.discoverable === false;
  sendHtml(res, 200, html, robots);
}

router.get(
  '/@:username/:postId',
  publicPageLimiter,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (wantsActivityPub(req)) return next();
    const username = String(req.params.username ?? '');
    if (!USERNAME_RE.test(username)) return sendHtml(res, 404, renderStatusPage(context(req, null), 'not_found'), true);
    return sendPublicPostPage(req, res, String(req.params.postId ?? ''), username);
  })
);

router.get(
  '/posts/:postId',
  publicPageLimiter,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (wantsActivityPub(req)) return next();
    return sendPublicPostPage(req, res, String(req.params.postId ?? ''), null);
  })
);

export default router;
