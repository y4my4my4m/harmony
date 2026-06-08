/**
 * Klipy only fills ads on mobile devices and requires a browser-like User-Agent
 * (not an app/network-stack UA). See:
 * https://docs.klipy.com/advertisements/receiving-an-ad#get-proper-user-agent
 */

/** True when the client's User-Agent looks like a mobile browser Klipy can serve ads to. */
export function isKlipyAdEligibleUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent || typeof userAgent !== 'string') return false;

  const ua = userAgent;

  // Klipy's documented anti-patterns: bare app / network stack UAs without a browser token.
  if (!/Mozilla|AppleWebKit/i.test(ua)) return false;
  if (/HarmonyFederation\//i.test(ua)) return false;
  if (/^[^\s]+\/[\d.]+ CFNetwork\//i.test(ua)) return false;

  // Coarse mobile device signal (iPhone, iPad, Android, …).
  return /Android|iPhone|iPod|iPad|Mobile/i.test(ua);
}
