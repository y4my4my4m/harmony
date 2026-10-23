/**
 * Shell of the public profile and post pages: head (OpenGraph, Twitter, canonical, robots,
 * ActivityPub alternate), the instance bar with its sign-in and sign-up links, the join card,
 * the footer, and the script that hands a signed-in browser to the app.
 *
 * Colours are the SPA's dark theme (src/assets/design-system.css) and its light preset
 * (useVisualTheme applyPresetTheme 'light'), switched by prefers-color-scheme.
 */

import config from '../config/index.js';
import { escapeHtml, resolveStorageUrl } from '../utils/html.js';
import { fillHtml, PAGE_STRINGS, type PageLocale, type PageStrings } from './strings.js';

/**
 * Cookie the app sets while signed in (src/utils/appSessionCookie.ts); the reverse proxy serves
 * the app for /@ paths with it.
 */
export const APP_SESSION_COOKIE = 'harmony_app';

/** sessionStorage key of the last hand-off: `<target path> <epoch ms>`. */
export const HAND_OFF_KEY = 'harmony:publicPageHop';

/** A second hand-off to the same target within this many ms stays on the page. */
export const HAND_OFF_WINDOW_MS = 10_000;

export interface PageInstance {
  name: string;
  iconUrl: string | null;
  registrationsOpen: boolean;
}

export interface PageContext {
  locale: PageLocale;
  t: PageStrings;
  instance: PageInstance;
  /** Path and query of this page: the sign-in link returns here. */
  path: string;
  /** https://<instance domain> */
  origin: string;
}

export function instanceOrigin(): string {
  return `https://${config.INSTANCE_DOMAIN}`;
}

/** The instance block of public_page_instance(), with config fallbacks. */
export function pageInstance(raw: any): PageInstance {
  const icon = typeof raw?.icon === 'string' && raw.icon ? raw.icon : null;
  return {
    name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : config.INSTANCE_NAME,
    iconUrl: icon ? absoluteUrl(resolveStorageUrl(icon, 'server_icons', 64)) : null,
    registrationsOpen: raw?.registrations_open !== false,
  };
}

export function pageContext(locale: PageLocale, instance: PageInstance, path: string): PageContext {
  return { locale, t: PAGE_STRINGS[locale], instance, path, origin: instanceOrigin() };
}

/** A root-relative URL made absolute on this instance; other values unchanged. */
export function absoluteUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return `${instanceOrigin()}${url}`;
  return url;
}

/** Origin of the storage the pages load media from when it is plain HTTP (development). */
function plainHttpStorageOrigin(): string {
  const base = config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL || '';
  try {
    const url = new URL(base);
    return url.protocol === 'http:' ? url.origin : '';
  } catch {
    return '';
  }
}

/** CSP of the pages: inline style and the hand-off script; media from any HTTPS origin. */
export function pageContentSecurityPolicy(): string {
  const http = plainHttpStorageOrigin();
  const media = `'self' data: https:${http ? ` ${http}` : ''}`;
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    `img-src ${media}`,
    `media-src ${media}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' https:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

export function formatDate(iso: string | null | undefined, locale: PageLocale, withTime = false): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, withTime
      ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }
      : { dateStyle: 'medium', timeZone: 'UTC' }).format(date) + (withTime ? ' UTC' : '');
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** `<time>` the closing script rewrites in the reader's time zone. */
export function timeHtml(iso: string | null | undefined, locale: PageLocale, withTime = false): string {
  if (!iso) return '';
  const text = formatDate(iso, locale, withTime);
  if (!text) return '';
  return `<time datetime="${escapeHtml(iso)}" data-style="${withTime ? 'datetime' : 'date'}">${escapeHtml(text)}</time>`;
}

export function formatCount(n: unknown, locale: PageLocale): string {
  const value = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  try {
    return new Intl.NumberFormat(locale, { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
  } catch {
    return String(value);
  }
}

/** Link to sign in, returning to this page afterwards. */
export function signInHref(ctx: PageContext): string {
  return `/login?redirect=${encodeURIComponent(ctx.path)}`;
}

const ICONS = {
  reply: '<path d="M9 17l-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  boost: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  pin: '<path d="M12 17v5"/><path d="M5 17h14l-1.8-2.7A2 2 0 0 1 17 13.2V7a2 2 0 0 1 2-2V3H5v2a2 2 0 0 1 2 2v6.2a2 2 0 0 1-.2 1.1z"/>',
  eyeOff: '<path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-10-8-10-8a18 18 0 0 1 5.1-5.9"/><path d="M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.2 3.2"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M2 2l20 20"/>',
  move: '<path d="M5 12h14"/><path d="M13 5l7 7-7 7"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="M11 19l-7-7 7-7"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
} as const;

export function icon(name: keyof typeof ICONS, label?: string): string {
  const a11y = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true"';
  return `<svg class="icon" viewBox="0 0 24 24" ${a11y}>${label ? `<title>${escapeHtml(label)}</title>` : ''}${ICONS[name]}</svg>`;
}

const STYLE = `
@font-face { font-family: 'Figtree'; font-style: normal; font-weight: 300 900; font-display: swap;
  src: url('/assets/fonts/Figtree-latin.woff2') format('woff2'); }
:root {
  color-scheme: light dark;
  --bg: #f2f3f5; --surface: #ffffff; --surface-2: #f6f6f7; --surface-3: #ebedef;
  --text: #1f2125; --text-2: #4e5058; --muted: #5c5e66; --border: rgba(0, 0, 0, 0.09);
  --link: #036399; --brand: #0EA5E9; --brand-hover: #0284C7; --on-brand: #ffffff;
  --warn-bg: rgba(161, 98, 7, 0.1); --warn: #8a5300;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 10px 30px rgba(0, 0, 0, 0.06);
  --radius: 14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121214; --surface: #1a1a1e; --surface-2: #17181a; --surface-3: #222327;
    --text: #f2f3f5; --text-2: #b5bac1; --muted: #8e9199; --border: rgba(255, 255, 255, 0.08);
    --link: #38bdf8; --warn-bg: rgba(250, 166, 26, 0.12); --warn: #fbbf24;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 18px 48px rgba(0, 0, 0, 0.35);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
  font: 15px/1.5 'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Hiragino Sans', 'Noto Sans JP', 'Noto Sans KR', 'Noto Sans SC', sans-serif;
  overflow-wrap: anywhere;
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 4px; }
h1, h2, p, dl, dd, ul, ol, figure { margin: 0; }
.icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.topbar {
  position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 16px; background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: saturate(1.4) blur(12px); -webkit-backdrop-filter: saturate(1.4) blur(12px);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; color: var(--text); font-weight: 700; font-size: 16px; }
.brand:hover { text-decoration: none; }
.brand img { width: 30px; height: 30px; border-radius: 9px; object-fit: cover; flex: none; }
.brand span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.actions { display: flex; gap: 8px; flex: none; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 14px;
  border-radius: 10px; font-weight: 600; font-size: 14px; white-space: nowrap; border: 1px solid transparent;
}
.btn:hover { text-decoration: none; }
.btn-primary { background: var(--brand); color: var(--on-brand); }
.btn-primary:hover { background: var(--brand-hover); }
.btn-ghost { background: var(--surface); color: var(--text); border-color: var(--border); }
.btn-ghost:hover { background: var(--surface-3); }
main { width: 100%; max-width: 680px; margin: 0 auto; padding: 20px 16px 8px; display: flex; flex-direction: column; gap: 16px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.join { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
.join h2 { font-size: 17px; }
.join p { color: var(--text-2); }
.join .actions { flex-wrap: wrap; }
.section-title { display: flex; align-items: center; gap: 6px; padding: 4px 4px 0; color: var(--muted); font-size: 13px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; }
.feed { display: flex; flex-direction: column; gap: 12px; }
.empty { padding: 28px 20px; text-align: center; color: var(--muted); }
.pager { display: flex; justify-content: space-between; gap: 12px; }
.pager a { flex: 1 1 0; }
.status { padding: 40px 24px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.status h1 { font-size: 22px; }
.status p { color: var(--text-2); }
footer.site { max-width: 680px; margin: 0 auto; padding: 16px 16px 32px; color: var(--muted); font-size: 13px; text-align: center; }
.custom-emoji { height: 1.25em; width: auto; vertical-align: -0.25em; margin: 0 0.05em; object-fit: contain; }
.back { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px; color: var(--text-2); font-weight: 600; }
.back span { min-width: 0; }
details > summary { list-style: none; cursor: pointer; }
details > summary::-webkit-details-marker { display: none; }
.toggle .less, details[open] > summary .toggle .more { display: none; }
details[open] > summary .toggle .less { display: inline; }
.post { padding: 16px 18px 12px; display: flex; flex-direction: column; gap: 10px; }
.post-page { padding: 20px 22px 14px; }
.pinned-label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; font-weight: 700; }
.post-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.author { display: flex; align-items: center; gap: 12px; min-width: 0; color: inherit; }
.author:hover { text-decoration: none; }
.author:hover .display-name { text-decoration: underline; }
.avatar { width: 46px; height: 46px; border-radius: 50%; object-fit: cover; background: var(--surface-3); flex: none; }
.post-page .post-head .avatar { width: 52px; height: 52px; }
.avatar.avatar-xs { width: 22px; height: 22px; }
.author-info { display: flex; flex-direction: column; min-width: 0; }
.display-name { font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.handle { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.post-time { flex: none; color: var(--muted); font-size: 13px; white-space: nowrap; }
.reply-to { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
.content { font-size: 15.5px; line-height: 1.55; }
.post-page .content { font-size: 17px; }
.content:empty { display: none; }
.content .mention, .content .hashtag { color: var(--link); }
.content-warning { padding: 10px 12px; border-radius: 10px; background: var(--warn-bg); color: var(--warn); font-weight: 600; }
.cw-body, .sensitive { display: flex; flex-direction: column; gap: 10px; }
.cw-body > summary, .sensitive > summary {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 14px;
  border-radius: 999px; background: var(--surface-3); color: var(--text); font-size: 13px; font-weight: 700;
}
.sensitive > summary .toggle { color: var(--link); }
.media-grid { display: grid; gap: 4px; margin-top: 2px; border-radius: 12px; overflow: hidden; }
.media-1 { grid-template-columns: 1fr; }
.media-2 { grid-template-columns: 1fr 1fr; aspect-ratio: 16 / 9; }
.media-3, .media-4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; aspect-ratio: 16 / 9; }
.media-3 > :first-child { grid-row: span 2; }
.media-many { grid-template-columns: repeat(3, 1fr); }
.media-many .media-item { aspect-ratio: 1; }
.media-item { position: relative; display: block; min-height: 0; overflow: hidden; background: var(--surface-3); }
.media-item img, .media-item video { display: block; width: 100%; height: 100%; object-fit: cover; }
.media-1 .media-item { max-height: 620px; }
.media-1 .media-item:not([style]) img, .media-1 .media-item:not([style]) video { height: auto; max-height: 620px; }
.media-audio { padding: 14px; }
.media-audio audio { width: 100%; }
.alt-badge { position: absolute; left: 8px; bottom: 8px; padding: 1px 6px; border-radius: 6px; background: rgba(0, 0, 0, 0.72); color: #fff; font-size: 11px; font-weight: 800; letter-spacing: 0.04em; cursor: help; }
.media-file { display: inline-flex; align-items: center; gap: 6px; }
.poll ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.poll-option { position: relative; display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; border-radius: 10px; background: var(--surface-2); overflow: hidden; }
.poll-bar { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--brand) 20%, transparent); }
.poll-option.lead .poll-bar { background: color-mix(in srgb, var(--brand) 36%, transparent); }
.poll-option.lead .poll-label { font-weight: 700; }
.poll-label, .poll-pct { position: relative; }
.poll-pct { font-variant-numeric: tabular-nums; font-weight: 700; }
.poll-meta { margin-top: 8px; color: var(--muted); font-size: 13px; }
.quote { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); color: var(--text); }
.quote:hover { text-decoration: none; border-color: color-mix(in srgb, var(--brand) 50%, var(--border)); }
.quote-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.quote-head .handle { min-width: 0; }
.quote-text { color: var(--text-2); white-space: pre-line; }
.quote-cw { color: var(--warn); font-weight: 600; }
.quote-image { width: 100%; max-height: 280px; object-fit: cover; border-radius: 8px; }
.quote time { color: var(--muted); font-size: 12px; }
.stats-bar { display: flex; align-items: center; gap: 18px; padding-top: 10px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
.stat { display: inline-flex; align-items: center; gap: 6px; }
.stat-count { font-variant-numeric: tabular-nums; }
.flags { margin-left: auto; display: inline-flex; align-items: center; gap: 12px; }
.visibility-badge { display: inline-flex; align-items: center; gap: 4px; }
.profile { overflow: hidden; }
.banner { aspect-ratio: 3 / 1; background: linear-gradient(135deg, var(--banner, var(--brand)), color-mix(in srgb, var(--banner, var(--brand)) 45%, #312e81)); }
.banner img { display: block; width: 100%; height: 100%; object-fit: cover; }
.profile-body { padding: 0 20px 18px; display: flex; flex-direction: column; gap: 12px; }
.profile-avatar { width: 104px; height: 104px; margin-top: -52px; border-radius: 50%; border: 4px solid var(--surface); background: var(--surface-3); object-fit: cover; }
.profile h1 { font-size: 24px; line-height: 1.2; }
.handle-line { display: flex; align-items: center; gap: 6px; margin-top: 2px; color: var(--muted); }
.handle-line .icon { width: 14px; height: 14px; }
.bio { color: var(--text); }
.bio p + p { margin-top: 8px; }
.fields { display: grid; grid-template-columns: minmax(96px, 32%) 1fr; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.fields dt, .fields dd { padding: 8px 12px; border-top: 1px solid var(--border); min-width: 0; }
.fields dt:first-of-type, .fields dd:first-of-type { border-top: 0; }
.fields dt { background: var(--surface-2); color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
.joined { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
.counts { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--muted); }
.counts strong { margin-right: 4px; color: var(--text); font-weight: 800; font-variant-numeric: tabular-nums; }
.moved { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--warn-bg); color: var(--warn); border-radius: 12px; font-weight: 600; }
@media (max-width: 480px) {
  .topbar { padding: 8px 12px; }
  .post, .post-page { padding: 14px 14px 10px; }
  .post-page .content { font-size: 16px; }
  .profile-body { padding: 0 16px 16px; }
  .profile-avatar { width: 88px; height: 88px; margin-top: -44px; }
  .profile h1 { font-size: 21px; }
  .fields { grid-template-columns: 1fr; }
  .fields dd { border-top: 0; padding-top: 0; }
  .btn { min-height: 34px; padding: 0 11px; font-size: 13px; }
  .topbar .btn-primary { display: none; }
  main { padding: 12px 10px 8px; gap: 12px; }
}
`;

/** Rewrites each `<time data-style>` in the reader's locale and time zone. */
const TIME_SCRIPT = `(function(){try{var l=document.documentElement.lang;var t=document.querySelectorAll('time[data-style]');for(var i=0;i<t.length;i++){var e=t[i];var d=new Date(e.getAttribute('datetime'));if(isNaN(d))continue;var o=e.getAttribute('data-style')==='datetime'?{dateStyle:'medium',timeStyle:'short'}:{dateStyle:'medium'};e.textContent=new Intl.DateTimeFormat(l,o).format(d);e.title=d.toLocaleString(l);}}catch(x){}})();`;

/**
 * A browser holding a Supabase session (supabase-js `sb-<ref>-auth-token`, in localStorage, or
 * in sessionStorage without "remember me") goes to the app: to `app` with the session cookie
 * set (the proxy then serves the app at that URL), or to `fallback` when it already carried
 * the cookie (the proxy ignored it). The same target twice within HAND_OFF_WINDOW_MS stays on
 * the page: no loop.
 */
export function handOffScript(app: string, fallback: string): string {
  const appJson = JSON.stringify(app).replace(/</g, '\\u003c');
  const fallbackJson = JSON.stringify(fallback).replace(/</g, '\\u003c');
  return `(function(){try{var s=false,b=[localStorage,sessionStorage];for(var j=0;j<b.length&&!s;j++){for(var i=0;i<b[j].length;i++){var k=b[j].key(i);if(k&&k.indexOf('sb-')===0&&k.slice(-11)==='-auth-token'){var v=JSON.parse(b[j].getItem(k)||'null');if(v&&(v.access_token||(v.currentSession&&v.currentSession.access_token))){s=true;break;}}}}if(!s)return;var c=/(?:^|;\\s*)${APP_SESSION_COOKIE}=1(?:;|$)/.test(document.cookie);var t=c?${fallbackJson}:${appJson};var h='${HAND_OFF_KEY}';var p=(sessionStorage.getItem(h)||'').split(' ');if(p[0]===t&&Date.now()-Number(p[1])<${HAND_OFF_WINDOW_MS}){sessionStorage.removeItem(h);return;}document.cookie='${APP_SESSION_COOKIE}=1; Path=/; Max-Age=34560000; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');sessionStorage.setItem(h,t+' '+Date.now());location.replace(t);}catch(e){}})();`;
}

export interface ShellOptions {
  ctx: PageContext;
  title: string;
  description: string;
  canonical: string;
  noindex: boolean;
  ogType: 'profile' | 'article' | 'website';
  ogTitle: string;
  ogImage?: string | null;
  ogImageAlt?: string | null;
  ogImageWidth?: number | null;
  ogImageHeight?: number | null;
  twitterCard: 'summary' | 'summary_large_image';
  /** ActivityPub object or actor of the page. */
  activityPubUrl?: string | null;
  extraHead?: string;
  /** In-app URL for a signed-in browser, and where it goes when the proxy ignored the cookie. */
  handOff?: { app: string; fallback: string } | null;
  body: string;
}

/** The instance icon, else the app's (public/favicon/). */
function instanceMark(instance: PageInstance): string {
  return `<img src="${escapeHtml(instance.iconUrl || '/favicon/favicon-96x96.png')}" alt="">`;
}

function topBar(ctx: PageContext): string {
  return `<header class="topbar">
  <a class="brand" href="/">${instanceMark(ctx.instance)}<span>${escapeHtml(ctx.instance.name)}</span></a>
  <nav class="actions" aria-label="${escapeHtml(ctx.instance.name)}">
    <a class="btn btn-ghost" href="${escapeHtml(signInHref(ctx))}" data-testid="public-sign-in">${escapeHtml(ctx.t.signIn)}</a>
    ${ctx.instance.registrationsOpen ? `<a class="btn btn-primary" href="/register" data-testid="public-register">${escapeHtml(ctx.t.createAccount)}</a>` : ''}
  </nav>
</header>`;
}

/** The call to sign in or join, naming whom a visitor would follow. `nameHtml` is HTML. */
export function joinCard(ctx: PageContext, nameHtml: string): string {
  const instance = escapeHtml(ctx.instance.name);
  return `<section class="card join" data-testid="public-join" aria-labelledby="join-title">
  <h2 id="join-title">${fillHtml(ctx.t.joinTitle, { instance })}</h2>
  <p>${fillHtml(ctx.t.joinText, { name: nameHtml, instance })}</p>
  <div class="actions">
    ${ctx.instance.registrationsOpen ? `<a class="btn btn-primary" href="/register">${escapeHtml(ctx.t.createAccount)}</a>` : ''}
    <a class="btn btn-ghost" href="${escapeHtml(signInHref(ctx))}">${escapeHtml(ctx.t.signIn)}</a>
  </div>
</section>`;
}

function siteFooter(ctx: PageContext): string {
  const harmony = '<a href="https://mony.lol" rel="noopener">Harmony</a>';
  return `<footer class="site">${fillHtml(ctx.t.poweredBy, { harmony })} · <a href="/">${escapeHtml(config.INSTANCE_DOMAIN)}</a></footer>`;
}

export function renderShell(o: ShellOptions): string {
  const { ctx } = o;
  const head: string[] = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<title>${escapeHtml(o.title)}</title>`,
    `<meta name="description" content="${escapeHtml(o.description)}">`,
    '<meta name="color-scheme" content="light dark">',
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f2f3f5">',
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121214">',
    '<link rel="icon" href="/favicon/favicon-32x32.png" sizes="32x32">',
    `<link rel="canonical" href="${escapeHtml(o.canonical)}">`,
  ];
  if (o.noindex) head.push('<meta name="robots" content="noindex, noarchive">');
  head.push(
    `<meta property="og:type" content="${o.ogType}">`,
    `<meta property="og:site_name" content="${escapeHtml(ctx.instance.name)}">`,
    `<meta property="og:title" content="${escapeHtml(o.ogTitle)}">`,
    `<meta property="og:description" content="${escapeHtml(o.description)}">`,
    `<meta property="og:url" content="${escapeHtml(o.canonical)}">`,
    `<meta property="og:locale" content="${escapeHtml(ctx.locale)}">`,
  );
  if (o.ogImage) {
    head.push(`<meta property="og:image" content="${escapeHtml(o.ogImage)}">`);
    if (o.ogImageWidth) head.push(`<meta property="og:image:width" content="${Number(o.ogImageWidth)}">`);
    if (o.ogImageHeight) head.push(`<meta property="og:image:height" content="${Number(o.ogImageHeight)}">`);
    if (o.ogImageAlt) head.push(`<meta property="og:image:alt" content="${escapeHtml(o.ogImageAlt)}">`);
  }
  head.push(
    `<meta name="twitter:card" content="${o.twitterCard}">`,
    `<meta name="twitter:title" content="${escapeHtml(o.ogTitle)}">`,
    `<meta name="twitter:description" content="${escapeHtml(o.description)}">`,
  );
  if (o.ogImage) head.push(`<meta name="twitter:image" content="${escapeHtml(o.ogImage)}">`);
  if (o.activityPubUrl) head.push(`<link rel="alternate" type="application/activity+json" href="${escapeHtml(o.activityPubUrl)}">`);
  if (o.extraHead) head.push(o.extraHead);
  head.push(`<style>${STYLE}</style>`);
  if (o.handOff) head.push(`<script>${handOffScript(o.handOff.app, o.handOff.fallback)}</script>`);

  return `<!DOCTYPE html>
<html lang="${escapeHtml(ctx.locale)}">
<head>
  ${head.join('\n  ')}
</head>
<body>
${topBar(ctx)}
<main id="content">
${o.body}
</main>
${siteFooter(ctx)}
<script>${TIME_SCRIPT}</script>
</body>
</html>`;
}

/**
 * A page for an unknown or hidden profile or post, or for a failed read. Always noindex.
 * `handOff`: the in-app view a signed-in reader may still open (a followers-only post).
 */
export function renderStatusPage(
  ctx: PageContext,
  status: 'not_found' | 'unavailable',
  handOff: { app: string; fallback: string } | null = null,
): string {
  const title = status === 'not_found' ? ctx.t.notFoundTitle : ctx.t.unavailableTitle;
  const text = status === 'not_found' ? ctx.t.notFoundText : ctx.t.unavailableText;
  return renderShell({
    ctx,
    title: `${title} - ${ctx.instance.name}`,
    description: text,
    canonical: `${ctx.origin}${ctx.path}`,
    noindex: true,
    ogType: 'website',
    ogTitle: title,
    twitterCard: 'summary',
    handOff,
    body: `<section class="card status" data-testid="public-status" data-status="${status}">
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(text)}</p>
  <a class="btn btn-ghost" href="/">${fillHtml(ctx.t.backHome, { instance: escapeHtml(ctx.instance.name) })}</a>
</section>`,
  });
}
