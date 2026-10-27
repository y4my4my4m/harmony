// A known instance's icon, banner and theme colour, from federated_instances.metadata as the
// federation backend's probe stores them (record_instance_branding): icon_url, banner_url,
// theme_color and branding_read_at.

/** The icon a Harmony instance shows when its admin set none, as its own UI does. */
export const HARMONY_APP_ICON = '/img/app_icon_square.webp'

/** A stored read younger than this is not probed again. */
export const BRANDING_TTL_MS = 24 * 3600_000

export interface BrandedInstance {
  domain?: string | null
  software?: string | null
  metadata?: Record<string, unknown> | null
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^https?:\/\/\S+$/i.test(value) ? value : null
}

/** The instance's own icon, unless it failed to load; then Harmony's for a Harmony peer; else null. */
export function instanceIconUrl(instance: BrandedInstance, failed?: ReadonlySet<string>): string | null {
  const own = httpUrl(instance.metadata?.icon_url)
  if (own && !failed?.has(own)) return own
  return (instance.software ?? '').trim().toLowerCase() === 'harmony' ? HARMONY_APP_ICON : null
}

export function instanceBannerUrl(instance: BrandedInstance): string | null {
  return httpUrl(instance.metadata?.banner_url)
}

export function instanceThemeColor(instance: BrandedInstance): string | null {
  const value = instance.metadata?.theme_color
  return typeof value === 'string' && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : null
}

/** The banner's style: the image, else a band in the instance's theme colour, else null. */
export function instanceBannerStyle(instance: BrandedInstance): Record<string, string> | null {
  const banner = instanceBannerUrl(instance)
  if (banner) return { backgroundImage: `url("${banner.replace(/["\\]/g, (c) => `\\${c}`)}")` }
  const color = instanceThemeColor(instance)
  if (color) return { background: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 55%, transparent))` }
  return null
}

/** True when the stored branding is older than BRANDING_TTL_MS or was never read. */
export function brandingDue(instance: BrandedInstance, now: number = Date.now()): boolean {
  const readAt = Date.parse(String(instance.metadata?.branding_read_at ?? ''))
  return !Number.isFinite(readAt) || now - readAt > BRANDING_TTL_MS
}
