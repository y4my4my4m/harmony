const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

type Unit = 'second' | 'minute' | 'hour' | 'day'

const unitFormatters = new Map<string, Intl.NumberFormat>()

function formatUnit(value: number, unit: Unit, locale: string): string {
  const key = `${locale}:${unit}`
  let fmt = unitFormatters.get(key)
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' })
    unitFormatters.set(key, fmt)
  }
  return fmt.format(value)
}

/**
 * Compact timeline timestamp, Mastodon style: "now", "42s", "5m", "3h", "2d",
 * then a short calendar date ("Mar 5"; year appended outside the current year).
 * Future timestamps (clock skew) read as "now". Returns '' for unparseable input.
 */
export function formatShortRelativeTime(
  input: string | number | Date,
  options: { now?: number; locale?: string; nowLabel?: string } = {},
): string {
  const time = input instanceof Date ? input.getTime() : new Date(input).getTime()
  if (Number.isNaN(time)) return ''

  const now = options.now ?? Date.now()
  const locale = options.locale ?? 'en'
  const delta = now - time

  if (delta < 10 * SECOND) return options.nowLabel ?? 'now'
  if (delta < MINUTE) return formatUnit(Math.floor(delta / SECOND), 'second', locale)
  if (delta < HOUR) return formatUnit(Math.floor(delta / MINUTE), 'minute', locale)
  if (delta < DAY) return formatUnit(Math.floor(delta / HOUR), 'hour', locale)
  if (delta < WEEK) return formatUnit(Math.floor(delta / DAY), 'day', locale)

  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date)
}

/** Full local date and time for tooltips and the focused post. */
export function formatFullDateTime(input: string | number | Date, locale = 'en'): string {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>()

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  let fmt = relativeFormatters.get(locale)
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    relativeFormatters.set(locale, fmt)
  }
  return fmt
}

/**
 * formatShortRelativeTime spelled out for accessible names, on the same
 * thresholds: "now", "42 seconds ago", "5 minutes ago", "3 hours ago", "2 days
 * ago", then the calendar date ("March 5"; year appended outside the current
 * year). Returns '' for unparseable input.
 */
export function formatSpokenRelativeTime(
  input: string | number | Date,
  options: { now?: number; locale?: string } = {},
): string {
  const time = input instanceof Date ? input.getTime() : new Date(input).getTime()
  if (Number.isNaN(time)) return ''

  const now = options.now ?? Date.now()
  const locale = options.locale ?? 'en'
  const delta = now - time
  const rtf = relativeFormatter(locale)

  if (delta < 10 * SECOND) return rtf.format(0, 'second')
  if (delta < MINUTE) return rtf.format(-Math.floor(delta / SECOND), 'second')
  if (delta < HOUR) return rtf.format(-Math.floor(delta / MINUTE), 'minute')
  if (delta < DAY) return rtf.format(-Math.floor(delta / HOUR), 'hour')
  if (delta < WEEK) return rtf.format(-Math.floor(delta / DAY), 'day')

  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date)
}
