// Strip tracking / analytics parameters from URLs without changing the
// destination resource. Two layers:
//
//   1. `UNIVERSAL_TRACKING_PARAMS` / `UNIVERSAL_TRACKING_PREFIXES` apply to
//      every URL regardless of host. Limited to strictly attribution/analytics
//      params (utm_*, fbclid, gclid, etc.) with no functional effect on the
//      destination page.
//   2. `DOMAIN_TRACKING_PARAMS` adds host-specific extras the universal list
//      must not touch (Twitter's `s` and `t`, YouTube's `feature`, TikTok's
//      share metadata).
//
// Only the rendered URL is cleaned. The original stays in the message body and
// database so federation peers see what the sender wrote.

// Always-stripped exact param names, drawn from the analytics suites of the
// major ad/email networks. All are inert for the resource they're attached to.
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

// Always-stripped param-name prefixes. Catches every Google / publisher utm_*
// variant (utm_brand, utm_social-type, utm_id, ...) and Matomo's pk_* style.
const UNIVERSAL_TRACKING_PREFIXES = [
  'utm_',
  'pk_',   // Matomo / Piwik
  'mtm_',  // Matomo newer
  'hsa_',  // HubSpot ads
]

// Host-specific extras, unsafe to apply universally: the same names are
// functional params on other domains. Keys are the domain without `www.`.
const DOMAIN_TRACKING_PARAMS: Record<string, string[]> = {
  // YouTube share-link extras
  'youtube.com': ['si', 'feature'],
  'youtu.be':    ['si', 'feature'],

  // X / Twitter share-link extras. `s` and `t` are post-share signature
  // tokens; the tweet still loads without them.
  'twitter.com': ['s', 't', 'ref_src', 'ref_url'],
  'x.com':       ['s', 't', 'ref_src', 'ref_url'],

  // TikTok share metadata
  'tiktok.com': [
    'is_from_webapp', 'is_copy_url', 'sender_device', 'sender_web_id',
    'share_id', 'share_app_id', 'share_link_id', 'share_item_id', 'share_channel',
  ],

  // Facebook referrers. `ref` and `refsrc` are FB-internal navigation flags;
  // links still load without them.
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

// Returns the original string when the input doesn't parse as a URL.
export function stripTrackingParameters(url: string): string {
  let urlObj: URL
  try {
    urlObj = new URL(url)
  } catch {
    return url
  }

  const domain = urlObj.hostname.replace(/^www\./i, '')
  const hostExtras = DOMAIN_TRACKING_PARAMS[domain] ?? []

  // Collect then delete; searchParams must not be mutated while iterating.
  const toDelete: string[] = []
  for (const name of urlObj.searchParams.keys()) {
    if (shouldStripParam(name, hostExtras)) toDelete.push(name)
  }
  if (toDelete.length === 0) return url

  for (const name of toDelete) urlObj.searchParams.delete(name)

  const cleaned = urlObj.toString()
  return cleaned.endsWith('?') ? cleaned.slice(0, -1) : cleaned
}

// Defaults to true when no localStorage entry exists.
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

// Module-scope to avoid recompiling per call. /g with .replace needs no
// lastIndex reset.
const URL_IN_TEXT_REGEX = /(\bhttps?:\/\/\S+)/g

// Strips every URL in a text blob. Called by the content processor before
// rendering messages / posts; the raw text persists in the DB.
export function stripUrlsInText(text: string): string {
  if (!text || !isUrlTrackingStrippingEnabled()) return text
  return text.replace(URL_IN_TEXT_REGEX, (match) => stripTrackingParameters(match))
}
