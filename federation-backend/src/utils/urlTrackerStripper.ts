/**
 * Strip tracking / analytics parameters from URLs without changing the
 * destination resource.
 *
 * This is a Node-only port of the frontend's
 * `src/utils/urlTrackerStripper.ts` (the original lives in the Vue app and
 * pulls in `localStorage` for the user opt-out toggle). The federation
 * backend doesn't have that toggle - server-rendered post pages always
 * show cleaned URLs - so this duplicate keeps the two `UNIVERSAL_TRACKING_*`
 * tables in sync without dragging the browser-only opt-out code into Node.
 *
 * IMPORTANT: when you add a tracker class here, mirror it in
 * `src/utils/urlTrackerStripper.ts` (and vice versa) so the SSR `/posts/:id`
 * page and the in-app post renderer agree on what gets stripped.
 */

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
]);

// Param-name prefixes that are always stripped (catches every Google /
// publisher utm_* variant including utm_brand, utm_social-type, utm_id, etc.
// and Matomo's pk_* style).
const UNIVERSAL_TRACKING_PREFIXES = [
  'utm_',
  'pk_',   // Matomo / Piwik
  'mtm_',  // Matomo newer
  'hsa_',  // HubSpot ads
];

// Host-specific extras that are NOT safe to apply universally (might break
// legit functional params on other domains). Keys are domain (no `www.`).
const DOMAIN_TRACKING_PARAMS: Record<string, string[]> = {
  'youtube.com': ['si', 'feature'],
  'youtu.be':    ['si', 'feature'],

  'twitter.com': ['s', 't', 'ref_src', 'ref_url'],
  'x.com':       ['s', 't', 'ref_src', 'ref_url'],

  'tiktok.com': [
    'is_from_webapp', 'is_copy_url', 'sender_device', 'sender_web_id',
    'share_id', 'share_app_id', 'share_link_id', 'share_item_id', 'share_channel',
  ],

  'facebook.com':   ['ref', 'refsrc'],
  'fb.com':         ['ref', 'refsrc'],
  'm.facebook.com': ['ref', 'refsrc'],
};

function shouldStripParam(name: string, hostExtras: ReadonlyArray<string>): boolean {
  if (UNIVERSAL_TRACKING_PARAMS.has(name)) return true;
  for (const prefix of UNIVERSAL_TRACKING_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return hostExtras.includes(name);
}

/**
 * Strip tracking parameters from a URL. Returns the original string if the
 * input doesn't parse as a URL.
 */
export function stripTrackingParameters(url: string): string {
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    return url;
  }

  const domain = urlObj.hostname.replace(/^www\./i, '');
  const hostExtras = DOMAIN_TRACKING_PARAMS[domain] ?? [];

  // Collect-then-delete so we don't mutate while iterating.
  const toDelete: string[] = [];
  for (const name of urlObj.searchParams.keys()) {
    if (shouldStripParam(name, hostExtras)) toDelete.push(name);
  }
  if (toDelete.length === 0) return url;

  for (const name of toDelete) urlObj.searchParams.delete(name);

  const cleaned = urlObj.toString();
  return cleaned.endsWith('?') ? cleaned.slice(0, -1) : cleaned;
}
