/** Amount in `currency`, whole units without decimals. An unknown currency code prints before the number. */
export function formatMoney(amount: number, currency: string, locale: string): string {
  const value = Number(amount) || 0
  const digits = value % 1 === 0 ? 0 : 2
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
  } catch {
    return `${currency} ${value.toFixed(digits)}`
  }
}

/** Day and month of a UTC instant, read in UTC: a monthly period ends at 00:00 UTC. */
export function formatUtcDay(iso: string, locale: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(time)
}

/** Day and month in the viewer's time zone. */
export function formatDay(iso: string, locale: string): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(time)
}

/** Time of day, and the day when it is not today, in the viewer's time zone. */
export function formatUntil(iso: string, locale: string, now: number = Date.now()): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const sameDay = new Date(time).toDateString() === new Date(now).toDateString()
  return new Intl.DateTimeFormat(locale, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(time)
}

const PLATFORM_LABELS: Record<string, string> = {
  'ko-fi': 'Ko-fi',
  'patreon': 'Patreon',
  'github-sponsors': 'GitHub Sponsors',
  'liberapay': 'Liberapay',
  'open-collective': 'Open Collective',
  'paypal': 'PayPal',
  'buymeacoffee': 'Buy Me a Coffee',
  'stripe': 'Stripe',
}

/** Display name to key: "Ko-fi" -> "ko-fi", "GitHub Sponsors" -> "github-sponsors". */
export const fundingPlatformKey = (platform: string): string => (platform ?? '').toLowerCase().replace(/\s+/g, '-')

/** The platform's own name; an unknown platform as written. */
export const fundingPlatformLabel = (platform: string): string => PLATFORM_LABELS[fundingPlatformKey(platform)] ?? platform
