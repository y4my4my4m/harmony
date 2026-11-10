/**
 * Snippets a server's owner pastes into a website. Paths as federation-backend
 * routes/inviteWidget.ts answers them, behind /api/federation on every proxy.
 */

import { escapeHtml } from '@/utils/sanitize'

export interface InviteWidgetUrls {
  badge: string
  join: string
  icon: string
  card: string
}

export interface InviteWidgetSnippets {
  urls: InviteWidgetUrls
  badgeHtml: string
  badgeMarkdown: string
  joinHtml: string
  iconHtml: string
  cardHtml: string
}

const LANGS = new Set(['de', 'es', 'fr', 'ja', 'ko', 'zh'])

function escapeMarkdownLabel(text: string): string {
  return text.replace(/[\\[\]]/g, '\\$&')
}

/** Snippets of the invite link `inviteUrl`; null when it is no invite URL. */
export function inviteWidgetSnippets(inviteUrl: string, serverName: string, locale?: string): InviteWidgetSnippets | null {
  let parsed: URL
  try {
    parsed = new URL(inviteUrl)
  } catch {
    return null
  }
  const code = /^\/invite\/([A-Za-z0-9_-]+)\/?$/.exec(parsed.pathname)?.[1]
  if (!code) return null

  const lang = locale?.split('-')[0]
  const base = `${parsed.origin}/api/federation/widget/invite/${code}`
  const query = (extra?: string): string => {
    const params = [extra, lang && LANGS.has(lang) ? `lang=${lang}` : ''].filter(Boolean).join('&')
    return params ? `?${params}` : ''
  }
  const urls: InviteWidgetUrls = {
    badge: `${base}/badge.svg${query()}`,
    join: `${base}/badge.svg${query('style=join')}`,
    icon: `${base}/badge.svg${query('style=icon')}`,
    card: `${base}${query()}`,
  }

  const alt = escapeHtml(`Join ${serverName}`)
  const linked = (src: string) =>
    `<a href="${escapeHtml(inviteUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(src)}" alt="${alt}" height="28"></a>`

  return {
    urls,
    badgeHtml: linked(urls.badge),
    badgeMarkdown: `[![${escapeMarkdownLabel(`Join ${serverName}`)}](${urls.badge})](${inviteUrl})`,
    joinHtml: linked(urls.join),
    iconHtml: linked(urls.icon),
    cardHtml: `<iframe src="${escapeHtml(urls.card)}" title="${alt}" width="340" height="72" style="border:0" loading="lazy" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>`,
  }
}
