/**
 * User-Agent of outbound requests: `Harmony/<version> (+https://<domain>/)`, the form of
 * Mastodon's `Mastodon/<version> (http.rb/<version>; +https://<domain>/)`. The
 * configuration sets it as it loads; until then it is `Harmony`.
 */
let agent = 'Harmony';

export function federationUserAgent(): string {
  return agent;
}

export function formatUserAgent(version: string, domain: string): string {
  return `Harmony/${version} (+https://${domain}/)`;
}

export function setFederationUserAgent(value: string): void {
  agent = value;
}
