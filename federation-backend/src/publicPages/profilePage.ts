/**
 * The public page of a local account: banner, avatar, name, bio, fields, counts, then its
 * pinned and public posts, newest first, twenty to a page. Data from
 * public.public_profile_page (migration 20261027800001_public_profile_pages.sql).
 */

import config from '../config/index.js';
import { escapeHtml, resolveStorageUrl } from '../utils/html.js';
import { plainDisplayName } from '../utils/plainDisplayName.js';
import { fieldValueToHtml, textToHtml } from '../activitypub/converters/toActivityPub.js';
import {
  authorHandle,
  avatarOriginal,
  emojifyHtml,
  renderDisplayNameHtml,
  renderPostCard,
} from '../activitypub/postPageRenderer.js';
import {
  absoluteUrl,
  formatCount,
  icon,
  joinCard,
  renderShell,
  timeHtml,
  type PageContext,
} from './layout.js';
import { fillHtml, fillText } from './strings.js';

export interface ProfilePageData {
  account: any;
  pinned: any[];
  posts: any[];
  next: string | null;
}

export interface ProfilePageOptions {
  /** noindex regardless of the account: the pages are off. */
  noindex?: boolean;
  /** The `before` cursor of this page; null on the first page. */
  before: string | null;
}

const SAFE_HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

function bioPlainText(bio: string): string {
  return bio.replace(/​/g, '').replace(/\s+/g, ' ').trim();
}

function safeHttp(url: unknown): string {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : '';
}

export function renderProfilePage(page: ProfilePageData, ctx: PageContext, options: ProfilePageOptions): string {
  const account = page.account;
  const username = String(account.username);
  const profileUrl = `https://${config.INSTANCE_DOMAIN}/@${encodeURIComponent(username)}`;
  const actorUrl = `https://${config.INSTANCE_DOMAIN}/users/${encodeURIComponent(username)}`;
  const handle = authorHandle(account);
  const displayNamePlain = plainDisplayName(account.display_name, username);
  const nameHtml = renderDisplayNameHtml(account.display_name || username, account.display_name_emojis);
  const bio = typeof account.bio === 'string' ? account.bio : '';
  const bioHtml = bio.trim() ? emojifyHtml(textToHtml(bio), account.bio_emojis) : '';
  const bioText = bioPlainText(bio);
  const description = bioText
    ? (bioText.length > 200 ? `${bioText.slice(0, 197)}...` : bioText)
    : fillText(ctx.t.profileOn, { name: displayNamePlain, instance: ctx.instance.name });

  const bannerSrc = absoluteUrl(resolveStorageUrl(account.banner_url, 'banners'));
  const bannerColor = typeof account.color === 'string' && SAFE_HEX_COLOR.test(account.color) ? account.color : '';
  const avatar = absoluteUrl(resolveStorageUrl(account.avatar_url, 'avatars', 208)) || `https://${config.INSTANCE_DOMAIN}/default_avatar.webp`;
  const movedTo = safeHttp(account.moved_to_uri);

  const fields = (Array.isArray(account.profile_fields) ? account.profile_fields : [])
    .filter((f: any) => f && (String(f.name ?? '').trim() || String(f.value ?? '').trim()))
    .slice(0, 8)
    .map((f: any) => `<dt>${escapeHtml(String(f.name ?? ''))}</dt><dd>${fieldValueToHtml(f.value)}</dd>`)
    .join('');

  const counts = [
    [account.posts_count, ctx.t.posts],
    [account.followers_count, ctx.t.followers],
    [account.following_count, ctx.t.following],
  ].map(([n, label]) => `<li><strong>${formatCount(n, ctx.locale)}</strong>${escapeHtml(String(label))}</li>`).join('');

  const header = `<section class="card profile" data-testid="public-profile" aria-labelledby="profile-name">
  <div class="banner"${bannerColor ? ` style="--banner: ${bannerColor}"` : ''}>${bannerSrc ? `<img src="${escapeHtml(bannerSrc)}" alt="">` : ''}</div>
  <div class="profile-body">
    <img class="profile-avatar" src="${escapeHtml(avatar)}" alt="" width="104" height="104">
    <div>
      <h1 id="profile-name" class="display-name">${nameHtml}</h1>
      <p class="handle-line"><span class="handle"><!--email_off-->${escapeHtml(handle)}<!--/email_off--></span>${account.locked ? icon('lock', ctx.t.locked) : ''}</p>
    </div>
    ${bioHtml ? `<div class="bio" data-testid="public-bio">${bioHtml}</div>` : ''}
    ${fields ? `<dl class="fields">${fields}</dl>` : ''}
    ${account.created_at ? `<p class="joined">${icon('calendar')}${fillHtml(ctx.t.joined, { date: timeHtml(account.created_at, ctx.locale) })}</p>` : ''}
    <ul class="counts">${counts}</ul>
  </div>
</section>`;

  const moved = movedTo
    ? `<p class="moved" data-testid="public-moved">${icon('move')}<span>${fillHtml(ctx.t.movedTo, {
      account: `<a href="${escapeHtml(movedTo)}" rel="nofollow noopener">${escapeHtml(movedTo.replace(/^https?:\/\//, ''))}</a>`,
    })}</span></p>`
    : '';

  const pinned = page.pinned.length > 0
    ? `<div class="feed" data-testid="public-pinned">${page.pinned.map((p) => renderPostCard(p, ctx, { level: 'feed', pinned: true })).join('\n')}</div>`
    : '';

  const list = page.posts.length > 0
    ? page.posts.map((p) => renderPostCard(p, ctx, { level: 'feed' })).join('\n')
    : page.pinned.length === 0 ? `<p class="card empty">${escapeHtml(ctx.t.noPosts)}</p>` : '';

  const pager: string[] = [];
  if (options.before) pager.push(`<a class="btn btn-ghost" href="/@${encodeURIComponent(username)}" rel="first">${escapeHtml(ctx.t.newestPosts)}</a>`);
  if (page.next) pager.push(`<a class="btn btn-ghost" href="/@${encodeURIComponent(username)}?before=${encodeURIComponent(page.next)}" rel="next" data-testid="public-older">${escapeHtml(ctx.t.olderPosts)}</a>`);

  const firstImage = avatarOriginal(account);

  return renderShell({
    ctx,
    title: `${displayNamePlain} (${handle}) - ${ctx.instance.name}`,
    description,
    canonical: profileUrl,
    noindex: options.noindex === true || account.discoverable === false || Boolean(movedTo) || Boolean(options.before),
    ogType: 'profile',
    ogTitle: `${displayNamePlain} (${handle})`,
    ogImage: firstImage,
    twitterCard: 'summary',
    activityPubUrl: actorUrl,
    extraHead: `<meta property="profile:username" content="${escapeHtml(handle.slice(1))}">`,
    handOff: { app: `/@${encodeURIComponent(username)}`, fallback: `/social/profile/${encodeURIComponent(username)}` },
    body: `${header}
${moved}
${joinCard(ctx, nameHtml)}
<h2 class="section-title">${escapeHtml(ctx.t.posts)}</h2>
${pinned}
<div class="feed" data-testid="public-feed">${list}</div>
${pager.length ? `<nav class="pager">${pager.join('')}</nav>` : ''}`,
  });
}
