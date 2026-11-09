/**
 * Website widgets of a server invite: an SVG badge for an <img> and a card page for an <iframe>.
 * Both show what /invite/:code shows to anyone holding the code, and neither runs script.
 */

import config from '../config/index.js';
import { escapeHtml, originalStorageUrl } from '../utils/html.js';
import { isDefaultServerIcon } from '../utils/urlUtils.js';
import { plainDisplayName } from '../utils/plainDisplayName.js';
import { inviteUrl, type InvitePreview } from './invitePreview.js';
import { THEME_COLOR, truncate } from './invitePageRenderer.js';

/** public/img/app_icon_badge.png, 96x96, white on transparent. An SVG in an <img> loads nothing external. */
const MARK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAMAAADVRocKAAAAAXNSR0IB2cksfwAAAAlwSFlzAAALEwAACxMBAJqcGAAAAotQTFRFAAAA////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////XZkxLgAAANl0Uk5TAAMOHC07SExOS0Q1JhYLAhAvWoOoxtvr8/j6+fbw5dTAoXtSKw8HJ09tdnJgQBsiWJjJ/P/px5JVIAFFaH2CdVkyF7Dk/vTXnBqk3vvdCEOZ2P3swnooYsz1s0Es04QxpvIfon6L45MGZeApqoXcjB7LCZ6yEfcU1ltwqboM5zNWX3mKj5WGZmk97ToVv4EqJHMNsRK0HXzoBK3P4vFXkMUZPmyIuGNujQq90do4SV5vkc4YIzdGa3hkUE056sqavq8TLtA0zSWbapd/NpR075bZvEJTiY6HYWa8nc8AAAR/SURBVHic7dl/TBtVHADw992cxgULZSYtuEB0FKMbZInJZLAfZEG6InGTJW4s27B1ccUtWhu2OgVR5uZwP1nGbGGisAWCibKNzLpfzrkwxo+MIVmNw0habaeEhR8SsihtvdfrtUcLlpX3NZrw/evu9d33c3e8u/f4HhDkgGlgGvj3APCGsDHIEogCX/glLrrvD0gUjrOKzw6SuRb73OATcTxG+153i5pSW1L4DFdcwcCKXhlYYgmR0t9nDXlbVXdiAX6b8PQczzgdMWbvzgvckW1ybiOOGp+PBSQq6PafpAKg5xp3Qk+Ys/onzs6HvGu5q5Fech5Al79ZNtw5IAI0YI4dc1i8tMr1UiTcCJGdj6h596q1AK1jGuMGW4Z9wNazjwYeFMfdmmuTSu8h5lvb5YGNrqRqL6A7FZSfSSz9s9wD6OEKSn5C0mEfBaI3f4MExP14iwMMl12hu4YZGb1VQHZ2hRqJU4jMPaCdcw4vP1kJ8GTC74hAFsB7x4MGMMO48yqUXO1HBKRRsOs0Yn5C0uCDU6jAi7BsBBXIgQ+bEB8DIl8Cpb6pASN+KYD9tTMQgVwjkIO1iMCIBcih7tbQHcMM29s67nVdVoO1+pLaLXQ+ONLZiQTkwTbPlKnK/hQl/8rGTu+kf8zeyv6F5JZlv0aEZYtCD8cZ54fnZu4iPoCYoIIx0JdzkIgAQ4KJMaDVDYuBWcaPGQPyHI0YmP8w4/zcclEtAkw29jP/No3LD1T/cJE5AB2jfqBmx1zmgHurxg+cKGOen1tTb/ABqZI+BODN+jMCMKPqKAJgu+sUgIiUAQQg6eRfApBmxVjdSdXrBaDuAEJ+QgrWCcDqX1GARImRB+rhIxTA0F7KAzPr96IA0P8TD3yhk6EA9vIcHmg4YUMBSOFqHpjzOE5+UrTKA0Sm9SIB6i4jBSTFdUjAuzbPuqixif1kwIdWnk2BQ7Xu0H3Dinz58xRIWjCZ0lg4Yf8kiwLp0UijlLidNylgLkLKT8ianRQoOYMGvLGRAmjPmedR5oBNFjSAv4KvC9GA3UoKLLmHld/xWSYFLrwcgwTkx2dQ4IFzBiQgZt5hCmxX7UACEttve+aD3Q1IwIiFn3DOq3H+CBBxmQcMSpx7pLzrXbYQcyXG607RQMe/B1hRiHEJee8MCQBJX8S+uhx/2/M5gQcSTduZAz2jg36AJB8pYJz/ACwjIoBcBR3T/Lk13hKOr1TUBK8zzL//ocUkACAbNrO7S5EjzcKmqNilKl7D5omO1nSU+nbE1TT92hIWlfgt5flb/Htjy3UJtX9M9dW9SJ3iFO8H1AOhDTqMU0gfs7a5PCBjYJfU3vQbjvAKC9Hrk78LGuzjVTSPmhyPvHX+Pt9/la8srXxwnH+3JyiZFvXczK0svNQ3qVqhvbiif4/k233j/vgPNdmiZ+tG2748WX2xueXCwqASvfTW8gzrwLqIVUNP6a3vPz3hZ8mQRV9thTIzSQaNSufsw7PJYpJMvr+kNzcrNi1U7P3KWPbz9RBfPP873/Sngf8v8Dc1YCz0C1AjcQAAAABJRU5ErkJggg==';

export type WidgetTheme = 'dark' | 'light';
export type BadgeStyle = 'full' | 'join' | 'icon';

const NAME_LIMIT = 28;

interface WidgetText {
  join: string;
  joinOn: (instance: string) => string;
  members: (n: string, count: number) => string;
  online: (n: string) => string;
  invalid: string;
}

const TEXT: Record<string, WidgetText> = {
  en: {
    join: 'Join',
    joinOn: (i) => `Join us on ${i}`,
    members: (n, c) => `${n} ${c === 1 ? 'member' : 'members'}`,
    online: (n) => `${n} online`,
    invalid: 'Invite no longer valid',
  },
  de: {
    join: 'Beitreten',
    joinOn: (i) => `Komm zu uns auf ${i}`,
    members: (n, c) => `${n} ${c === 1 ? 'Mitglied' : 'Mitglieder'}`,
    online: (n) => `${n} online`,
    invalid: 'Einladung nicht mehr gültig',
  },
  es: {
    join: 'Unirse',
    joinOn: (i) => `Únete en ${i}`,
    members: (n, c) => `${n} ${c === 1 ? 'miembro' : 'miembros'}`,
    online: (n) => `${n} en línea`,
    invalid: 'La invitación ya no es válida',
  },
  fr: {
    join: 'Rejoindre',
    joinOn: (i) => `Rejoignez-nous sur ${i}`,
    members: (n, c) => `${n} ${c === 1 ? 'membre' : 'membres'}`,
    online: (n) => `${n} en ligne`,
    invalid: "Cette invitation n'est plus valide",
  },
  ja: {
    join: '参加',
    joinOn: (i) => `${i}で参加`,
    members: (n) => `${n}人のメンバー`,
    online: (n) => `${n}人がオンライン`,
    invalid: 'この招待は無効です',
  },
  ko: {
    join: '참가',
    joinOn: (i) => `${i}에서 참가하기`,
    members: (n) => `멤버 ${n}명`,
    online: (n) => `${n}명 접속 중`,
    invalid: '더 이상 유효하지 않은 초대입니다',
  },
  zh: {
    join: '加入',
    joinOn: (i) => `在 ${i} 上加入我们`,
    members: (n) => `${n} 位成员`,
    online: (n) => `${n} 人在线`,
    invalid: '邀请已失效',
  },
};

export function widgetText(lang: unknown): WidgetText {
  return typeof lang === 'string' && Object.hasOwn(TEXT, lang) ? TEXT[lang] : TEXT.en;
}

export function widgetTheme(value: unknown): WidgetTheme {
  return value === 'light' ? 'light' : 'dark';
}

export function badgeStyle(value: unknown): BadgeStyle {
  return value === 'icon' || value === 'join' ? value : 'full';
}

const COLORS: Record<WidgetTheme, { bg: string; fg: string; muted: string; border: string }> = {
  dark: { bg: '#1a1a1e', fg: '#f2f3f5', muted: '#b5bac1', border: 'rgba(255,255,255,0.12)' },
  light: { bg: '#ffffff', fg: '#17181c', muted: '#4e5058', border: 'rgba(0,0,0,0.16)' },
};

// XML 1.0 refuses these even as escaped text; a name holding one would void the whole image.
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

function xml(text: string): string {
  return escapeHtml(text.replace(XML_INVALID, ''));
}

function name(preview: InvitePreview): string {
  return truncate(plainDisplayName(preview.name, preview.name), NAME_LIMIT);
}

/** Pixels of `text` at `size`: a width per class of character. textLength holds the text to it. */
export function textWidth(text: string, size: number): number {
  let width = 0;
  for (const ch of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) width += size;
    else if (/\p{Extended_Pictographic}/u.test(ch)) width += size * 1.25;
    else if (/[iIljtf.,:;'|! ]/.test(ch)) width += size * 0.34;
    else if (/[A-Zmw]/.test(ch)) width += size * 0.72;
    else width += size * 0.56;
  }
  return Math.ceil(width);
}

function counts(preview: InvitePreview, text: WidgetText): string {
  return preview.onlineCount
    ? text.online(preview.onlineCount.toLocaleString('en-US'))
    : text.members(preview.memberCount.toLocaleString('en-US'), preview.memberCount);
}

const FONT = "Figtree,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans',sans-serif";
const HEIGHT = 28;
const MARK_BOX = 30;
const PAD = 10;

function svg(width: number, label: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${xml(label)}"><title>${xml(label)}</title>${body}</svg>`;
}

function markSegment(width: number): string {
  return `<rect width="${width}" height="${HEIGHT}" fill="${THEME_COLOR}"/><image href="${MARK}" x="${(width - 18) / 2}" y="5" width="18" height="18"/>`;
}

function textRun(x: number, content: string, width: number, fill: string, size: number, weight: number): string {
  return `<text x="${x}" y="18.5" fill="${fill}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" textLength="${width}" lengthAdjust="spacingAndGlyphs">${xml(content)}</text>`;
}

/** Badge of a valid invite, or of a dead one when `preview` is null. */
export function renderInviteBadge(
  preview: InvitePreview | null,
  options: { theme?: WidgetTheme; style?: BadgeStyle; lang?: unknown } = {},
): string {
  const text = widgetText(options.lang);
  const style = options.style ?? 'full';
  const color = COLORS[options.theme ?? 'dark'];
  const clip = (width: number) =>
    `<clipPath id="r"><rect width="${width}" height="${HEIGHT}" rx="6"/></clipPath>`;
  const frame = (width: number) =>
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${HEIGHT - 1}" rx="5.5" fill="none" stroke="${color.border}"/>`;

  if (!preview) {
    const width = textWidth(text.invalid, 12);
    const total = width + PAD * 2;
    return svg(total, text.invalid, `${clip(total)}<g clip-path="url(#r)"><rect width="${total}" height="${HEIGHT}" fill="${color.bg}"/>${textRun(PAD, text.invalid, width, color.muted, 12, 500)}</g>${frame(total)}`);
  }

  const server = name(preview);
  const label = `${text.join} ${server} · ${config.INSTANCE_NAME}`;

  if (style === 'icon') {
    return svg(HEIGHT, label, `${clip(HEIGHT)}<g clip-path="url(#r)">${markSegment(HEIGHT)}</g>`);
  }

  if (style === 'join') {
    const line = text.joinOn(plainDisplayName(config.INSTANCE_NAME, config.INSTANCE_NAME));
    const width = textWidth(line, 12);
    const total = width + PAD * 2 + MARK_BOX;
    return svg(total, label, `${clip(total)}<g clip-path="url(#r)"><rect width="${total}" height="${HEIGHT}" fill="${THEME_COLOR}"/>${markSegment(MARK_BOX)}${textRun(MARK_BOX, line, width, '#ffffff', 12, 600)}</g>`);
  }

  const serverWidth = textWidth(server, 12);
  const line = counts(preview, text);
  const countWidth = textWidth(line, 11);
  const total = MARK_BOX + PAD + serverWidth + 8 + countWidth + PAD;
  return svg(total, `${label}, ${line}`, [
    clip(total),
    '<g clip-path="url(#r)">',
    `<rect width="${total}" height="${HEIGHT}" fill="${color.bg}"/>`,
    markSegment(MARK_BOX),
    textRun(MARK_BOX + PAD, server, serverWidth, color.fg, 12, 600),
    textRun(MARK_BOX + PAD + serverWidth + 8, line, countWidth, color.muted, 11, 400),
    '</g>',
    frame(total),
  ].join(''));
}

function iconUrl(preview: InvitePreview): string {
  const raw = preview.icon?.trim();
  if (raw && !isDefaultServerIcon(raw)) {
    const url = originalStorageUrl(raw, 'server_icons');
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('/') && !url.startsWith('//')) return `https://${config.INSTANCE_DOMAIN}${url}`;
  }
  return `https://${config.INSTANCE_DOMAIN}/img/app_icon_square.png`;
}

function cardStyle(theme: WidgetTheme): string {
  const color = COLORS[theme];
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; background: transparent; }
    body { font-family: ${FONT}; color: ${color.fg}; line-height: 1.3; }
    .card {
      display: flex;
      align-items: center;
      gap: 12px;
      height: 100%;
      min-height: 72px;
      padding: 12px;
      background: ${color.bg};
      border: 1px solid ${color.border};
      border-radius: 12px;
    }
    .icon { width: 48px; height: 48px; border-radius: 12px; object-fit: cover; flex-shrink: 0; }
    .meta { flex: 1; min-width: 0; }
    .name { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .counts { color: ${color.muted}; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .join {
      flex-shrink: 0;
      padding: 8px 14px;
      background: ${THEME_COLOR};
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
    }
    .join:hover { background: #0284C7; }
    .join:focus-visible { outline: 2px solid ${color.fg}; outline-offset: 2px; }
    .dead { color: ${color.muted}; font-size: 13px; }`;
}

function cardPage(title: string, theme: WidgetTheme, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)}</title>
  <style>${cardStyle(theme)}
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Card of a valid invite, or of a dead one when `preview` is null. */
export function renderInviteCard(
  preview: InvitePreview | null,
  options: { theme?: WidgetTheme; lang?: unknown } = {},
): string {
  const text = widgetText(options.lang);
  const theme = options.theme ?? 'dark';
  if (!preview) {
    return cardPage(config.INSTANCE_NAME, theme, `  <main class="card"><p class="dead">${escapeHtml(text.invalid)}</p></main>`);
  }
  const server = plainDisplayName(preview.name, preview.name);
  return cardPage(server, theme, [
    '  <main class="card">',
    `    <img class="icon" src="${escapeHtml(iconUrl(preview))}" alt="">`,
    '    <div class="meta">',
    `      <p class="name">${escapeHtml(server)}</p>`,
    `      <p class="counts">${escapeHtml(counts(preview, text))}</p>`,
    '    </div>',
    `    <a class="join" href="${escapeHtml(inviteUrl(preview.code))}" target="_blank" rel="noopener">${escapeHtml(text.join)}</a>`,
    '  </main>',
  ].join('\n'));
}
