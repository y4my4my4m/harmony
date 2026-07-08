// Strip tracking/analytics params without changing the destination resource.
// Two layers: UNIVERSAL_TRACKING_PARAMS/_PREFIXES apply to every host (strictly
// attribution params with no functional effect); DOMAIN_TRACKING_PARAMS adds
// host-specific extras unsafe to apply universally.
// Cleaned URL is rendered; original stays in the DB/message body so federation
// peers see what the sender wrote.

// Always-stripped exact param names. Sourced from the analytics suites of
// the major ad/email networks. Any params here are inert for the resource
// they're attached to.
const UNIVERSAL_TRACKING_PARAMS = new Set<string>([
  // Click identifiers (ad network attribution)
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'dclid',
  'msclkid', 'yclid', 'twclid', 'ttclid', 'scid',
  'igshid', 'igsh', 'mibextid',

  // Email / CRM tracking
  'mc_eid', 'mc_cid',
  '_hsenc', '_hsmi', '_hsfp',
  'vero_id', 'vero_conv',
  'mkt_tok',
  'sc_cid', 'sc_clid',
  's_cid',
  'oly_anon_id', 'oly_enc_id',

  // Misc social / shorteners
  'epik',                  // Pinterest
  'spm',                   // Alibaba
  'algo_pvid',             // Aliexpress
  '__twitter_impression',  // Twitter web app embed flag
  'wt_zmc',                // Zalando
  'cmpid', 'cm_mmc',       // generic campaign ids
])

// Param-name prefixes that are always stripped (catches every Google /
// publisher utm_* variant including utm_brand, utm_social-type, utm_id, etc.
// and Matomo's pk_* style).
const UNIVERSAL_TRACKING_PREFIXES = [
  'utm_',
  'pk_',   // Matomo / Piwik
  'mtm_',  // Matomo newer
  'hsa_',  // HubSpot ads
]

// Host-specific extras that are NOT safe to apply universally (might break
// legit functional params on other domains). Keys are domain (no `www.`).
const DOMAIN_TRACKING_PARAMS: Record<string, string[]> = {
  // YouTube share-link extras
  'youtube.com': ['si', 'feature'],
  'youtu.be':    ['si', 'feature'],

  // X / Twitter share-link extras (`s` and `t` are post-share signature
  // tokens, dropping them still loads the tweet).
  'twitter.com': ['s', 't', 'ref_src', 'ref_url'],
  'x.com':       ['s', 't', 'ref_src', 'ref_url'],

  // TikTok share metadata
  'tiktok.com': [
    'is_from_webapp', 'is_copy_url', 'sender_device', 'sender_web_id',
    'share_id', 'share_app_id', 'share_link_id', 'share_item_id', 'share_channel',
  ],

  // Facebook referrers (`ref` and `refsrc` are FB-internal navigation flags;
  // links still load without them).
  'facebook.com':   ['ref', 'refsrc'],
  'fb.com':         ['ref', 'refsrc'],
  'm.facebook.com': ['ref', 'refsrc'],
}

function shouldStripParam(name: string, hostExtras: ReadonlyArray<string>): boolean {
  if (UNIVERSAL_TRACKING_PARAMS.has(name)) return true
  for (const prefix of UNIVERSAL_TRACKING_PREFIXES) {
    if (name.startsWith(prefix)) return true
  }
  return hostExtras.includes(name)
}

// Strip tracking parameters from a URL. Returns the original string if the
// input doesn't parse as a URL.
export function stripTrackingParameters(url: string): string {
  let urlObj: URL
  try {
    urlObj = new URL(url)
  } catch {
    return url
  }

  const domain = urlObj.hostname.replace(/^www\./i, '')
  const hostExtras = DOMAIN_TRACKING_PARAMS[domain] ?? []

  // Collect-then-delete so we don't mutate while iterating.
  const toDelete: string[] = []
  for (const name of urlObj.searchParams.keys()) {
    if (shouldStripParam(name, hostExtras)) toDelete.push(name)
  }
  if (toDelete.length === 0) return url

  for (const name of toDelete) urlObj.searchParams.delete(name)

  const cleaned = urlObj.toString()
  return cleaned.endsWith('?') ? cleaned.slice(0, -1) : cleaned
}

// Does the current user want URLs stripped before display? Defaults to true
// when there's no localStorage entry (privacy-friendly default).
export function isUrlTrackingStrippingEnabled(): boolean {
  try {
    const setting = localStorage.getItem('harmony-privacy-strip-url-trackers')
    return setting === null ? true : setting === 'true'
  } catch {
    return true
  }
}

export function setUrlTrackingStrippingEnabled(enabled: boolean): void {
  try {
    localStorage.setItem('harmony-privacy-strip-url-trackers', enabled ? 'true' : 'false')
  } catch (error) {
    console.error('Failed to save URL tracking stripping preference:', error)
  }
}

// Module-scope so we don't recompile on every call. /g + .replace doesn't
// need a lastIndex reset.
const URL_IN_TEXT_REGEX = /(\bhttps?:\/\/\S+)/g

// Strip tracking parameters from every URL found in a text blob. Used by
// the content processor before rendering messages / posts so the cleaned
// URLs are what the user sees, while the raw text persists in the DB.
export function stripUrlsInText(text: string): string {
  if (!text || !isUrlTrackingStrippingEnabled()) return text
  return text.replace(URL_IN_TEXT_REGEX, (match) => stripTrackingParameters(match))
}
